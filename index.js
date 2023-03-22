require('dotenv').config();

const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const { Client, GatewayIntentBits } = require('discord.js');
const textToSpeech = require('@google-cloud/text-to-speech');
// Import other required libraries
const fs = require('fs');
const util = require('util');
// Creates clients
const ttsclient = new textToSpeech.TextToSpeechClient();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildMessages]});
const crypto = require('crypto');
//discordjs/audio stuff
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    entersState 
} = require('@discordjs/voice');

client.login(process.env.DISCORD_BOT_TOKEN);

let globalqueue = {};

const commands = [
    {
        name: 'restart',
        description: 'Restart the bot process',
    },
    {
        name: 'say',
        description: 'Send a message to the voice channel queue',
        options: [{
            name: 'message',
            type: 3,
            description: 'The message to send to the queue',
            required: true,
        }, ],
    },
    {
        name: 'test',
        description: 'Add a test message to the voice channel queue',
    },
];

const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_BOT_TOKEN);

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    if (commandName === 'restart') {
        await interaction.reply('Restarting...');
        setTimeout(() => {
            process.exit(0);
        }, 500);
    }
    else if (commandName === 'say') {
        if (interaction.member.voice.channel) {
            const message = options.getString('message');
            addToQueue(message, interaction.member.voice);
            await interaction.reply(`Message "${message}" added to the queue!`);
        }
        else {
            await interaction.reply('You must be in a voice channel to use this command!');
        }
    }
    else if (commandName === 'test') {
        if (interaction.member.voice.channel) {
            addToQueue('Test', interaction.member.voice);
            await interaction.reply('Test message added to the queue!');
        }
        else {
            await interaction.reply('You must be in a voice channel to use this command!');
        }
    }
});

client.on('ready', async () => {
    console.log('announcerbot ready');

    try {
        await rest.put(
            Routes.applicationCommands(client.user.id), {
                body: commands
            },
        );

        console.log(`Successfully registered global slash commands`);
    }
    catch (error) {
        console.error(error);
    }
});

async function addToQueue(message, voiceState) {
    guildID = voiceState.guild.id;

    if (globalqueue[guildID] === undefined) {
        globalqueue[guildID] = {
            queue: [],
            player: null,
            connection: null,
        };
    }


    if (!voiceState.channel) {
        return;
    }

    if (!globalqueue[guildID].connection || globalqueue[guildID].connection.state.status === VoiceConnectionStatus.Destroyed) {
        console.debug("joining voice channel");
        globalqueue[guildID].connection = await joinVoiceChannel({
            channelId: voiceState.channelId,
            guildId: voiceState.guild.id,
            adapterCreator: voiceState.guild.voiceAdapterCreator,
        });
    }
    else if (globalqueue[guildID].connection.joinConfig.channelId !== voiceState.channelId &&
        globalqueue[guildID].player.state.status === AudioPlayerStatus.Idle) { //we're in the wrong channel for this message and not currently speaking time to move
        globalqueue[guildID].connection.destroy();
        globalqueue[guildID].connection = null;
        globalqueue[guildID].player = null;

        globalqueue[guildID].connection = await joinVoiceChannel({
            channelId: voiceState.channelId,
            guildId: voiceState.guild.id,
            adapterCreator: voiceState.guild.voiceAdapterCreator,
        });

    }

    if (!globalqueue[guildID].player) {
        globalqueue[guildID].player = createAudioPlayer();
        globalqueue[guildID].connection.subscribe(globalqueue[guildID].player);
        globalqueue[guildID].player.on('error', console.error);
        globalqueue[guildID].player.on('stateChange', async (oldState, newState) => {
            if (newState.status === AudioPlayerStatus.Idle) {
                const nextMessage = globalqueue[guildID].queue.shift();
                if (nextMessage) {
                    addToQueue(nextMessage.message, nextMessage.voiceState);
                }
                else {
                    globalqueue[guildID].connection.destroy();
                    globalqueue[guildID].connection = null;
                    globalqueue[guildID].player = null;
                }
            }
        });
    }

    if (globalqueue[guildID].player.state.status === AudioPlayerStatus.Idle) {
        await playMessage({
            message,
            voiceState
        });
    }
    else {
        globalqueue[guildID].queue.push({
            message,
            voiceState
        });
    }
}

async function playMessage({
    message,
    voiceState
}) {
    const guildID = voiceState.guild.id;
    const {
        connection,
        player
    } = globalqueue[guildID];
    const audioContent = await generateAudioContent(message);
    const audioResource = createAudioResource(audioContent);
    console.debug("playMessage");
    player.play(audioResource);
}

async function generateAudioContent(message) { //TODO playback is choking on whatever this is returning
    const cacheDirectory = './cache/';
    const cacheFilename = crypto.createHash('sha1').update(message.toLowerCase()).digest('hex') + '.ogg';
    const cachePath = cacheDirectory + cacheFilename;

    // Check if the file exists in the cache
    try {
        await util.promisify(fs.access)(cachePath, fs.constants.F_OK);
        console.debug(`Reading audio from cache for '${message}'`);
        return fs.createReadStream(cachePath);
    }
    catch {}

    console.debug(`Generating audio for '${message}'`);
    const request = {
        input: {
            text: message
        },
        voice: {
            languageCode: process.env.VOICE_LANGUAGE,
            name: process.env.VOICE_NAME,
            ssmlGender: process.env.VOICE_GENDER
        },
        audioConfig: {
            audioEncoding: 'OGG_OPUS'
        },
    };

    // Performs the text-to-speech request
    const [response] = await ttsclient.synthesizeSpeech(request);
    const audioContent = response.audioContent;

    // Cache the audio to disk
    try {
        await util.promisify(fs.mkdir)(cacheDirectory, {
            recursive: true
        });
        await util.promisify(fs.writeFile)(cachePath, audioContent, {
            encoding: null
        });
        return fs.createReadStream(cachePath);
        console.debug(`Wrote audio to cache for '${message}'`);
    }
    catch (err) {
        console.error(`Failed to write audio cache for '${message}': ${err}`);
    }

}

function getUserName(guildMember) {
    return (guildMember.nickname || guildMember.user.username);
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    var oldMember = oldState.member;
    var newMember = newState.member;

    //console.debug(newState.channel);
    if (newMember.id != client.user.id) { //ignore myself


        if (oldState.channel === null && newState.channel !== null) { //if not previously connected to a channel
            console.debug('-----joined ' + newState.channel.name + '-----');

            if (!newState.channel.joinable) return; //dont queue for unjoinable channels
            if (newState.channel.id == newState.guild.afkChannelId) return; //dont queue messages in afk channel

            addToQueue(getUserName(newMember) + " joined the channel", newState);
            return;
        }
        if (oldState.channel !== null && newState.channel === null) { //if disconnect
            console.debug('-----left ' + oldState.channel.name + '-----');

            if (!oldState.channel.joinable) return; //dont queue for unjoinable channels
            if (oldState.channel.id == oldState.guild.afkChannelId) return; //dont queue messages in afk channel

            addToQueue(getUserName(oldMember) + " left the channel", oldState);
            return;
        }
        if (oldState.channel != newState.channel) { //if changed channel
            console.debug('-----changed channel-----');
            console.debug('from ' + oldState.channel.name + ' to ' + newState.channel.name);

            if ((oldState.channel.joinable) && (oldState.channel.id != oldState.guild.afkChannelId)) {
                addToQueue(getUserName(oldMember) + " left the channel", oldState);
            }
            if ((newState.channel.joinable) && (newState.channel.id != newState.guild.afkChannelId)) {
                addToQueue(getUserName(newMember) + " joined the channel", newState);
            }

            return;
        }

        console.debug('-----here be dragons-----');

    }
});
