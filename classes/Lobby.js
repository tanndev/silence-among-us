const chance = require('chance').Chance();
const { Permissions, MessageEmbed } = require('discord.js');
const discordClient = require('../discord-bot/discord-bot');
const Player = require('./Player');
const Room = require('./Room');

const requiredTextPermissionsFlags = [
    'VIEW_CHANNEL',
    'SEND_MESSAGES',
    'MANAGE_MESSAGES'
];
const requiredTextPermissions = new Permissions((requiredTextPermissionsFlags));
const requiredVoicePermissionsFlags = [
    // TODO Confirm that 'CONNECT' and 'SPEAK' aren't required.
    'VIEW_CHANNEL',
    'MUTE_MEMBERS',
    'DEAFEN_MEMBERS'
];
const requiredVoicePermissions = new Permissions(requiredVoicePermissionsFlags);

/**
 * The valid phases of a lobby.
 */
const PHASE = {
    INTERMISSION: 'Intermission',
    WORKING: 'Working',
    MEETING: 'Meeting',
    MENU: 'Menu'
};

const AUTOMATION = {
    WAITING: 'Waiting',
    CONNECTED: 'Connected',
    DISCONNECTED: 'Disconnected'
};

/**
 * Maps voice channel IDs to lobbies.
 * @type {Map<string, Lobby>}
 */
const lobbiesByVoiceChannel = new Map();

/**
 * Maps connect codes to lobbies.
 * @type {Map<string, Lobby>}
 */
const lobbiesByConnectCode = new Map();

// TODO Store lobbies somewhere outside of memory.

/**
 * @property {string} voiceChannelId - Id of the voice channel associated with the lobby.
 * @property {string} phase - Current phase of the lobby.
 * @property {Player[]} players - All the current (and past) players.
 * @property {Discord.VoiceChannel} _voiceChannel - The bound voice channel.
 * @property {Discord.TextChannel} _textChannel - The bound text channel.
 */
class Lobby {

    /**
     * Create a new lobby for a channel.
     *
     * @param {string|Discord.VoiceChannel} voiceChannel - Voice channel, or the id of one.
     * @param {string|Discord.TextChannel} textChannel - Guild text channel, or the id of one.
     * @param {Room} [room] - A room to start with.
     * @returns {Promise<Lobby>}
     */
    static async start(voiceChannel, textChannel, room) {
        if (typeof voiceChannel === 'string') {
            // TODO Get the voice channel associated with the ID.
            throw new Error("Starting a channel by ID isn't supported yet.");
        }
        if (typeof textChannel === 'string') {
            // TODO Get the voice channel associated with the ID.
            throw new Error("Starting a channel by ID isn't supported yet.");
        }

        // Don't allow duplicate lobbies.
        if (await Lobby.findByVoiceChannel(voiceChannel)) throw new Error("There's already a lobby in that channel.");

        // Make sure the discord bot has sufficient permissions.
        if (!voiceChannel.permissionsFor(voiceChannel.guild.me).has(requiredVoicePermissions)) throw new Error([
            'Sorry, I don\'t have enough permissions in that voice channel.',
            `I need the following:\n\t- ${requiredVoicePermissionsFlags.join('\n\t- ')}`
        ].join('\n'));
        if (!textChannel.permissionsFor(textChannel.guild.me).has(requiredTextPermissions)) throw new Error([
            'Sorry, I don\'t have enough permissions in this text channel.',
            `I need the following:\n\t- ${requiredTextPermissionsFlags.join('\n\t- ')}`
        ].join('\n'));

        const voiceChannelId = voiceChannel.id;
        const textChannelId = textChannel.id;

        const lobby = new Lobby({ voiceChannelId, textChannelId, phase: PHASE.INTERMISSION, room });
        lobby._voiceChannel = voiceChannel;
        lobby._textChannel = textChannel;
        lobbiesByVoiceChannel.set(voiceChannelId, lobby);

        // Add players
        // TODO Do this silently.
        await Promise.all(voiceChannel.members.map(member => lobby.connectPlayer(member)));


        lobby.emit("Created");

        // TODO Save to database.

        return lobby;
    }

    /**
     * Find a lobby associated with a channel id.
     *
     * @param {string|Discord.VoiceChannel} voiceChannel - Voice channel, or channel ID.
     * @returns {Promise<Lobby>} - Lobby matching the channel, or null
     */
    static async findByVoiceChannel(voiceChannel) {
        if (typeof voiceChannel === 'string') voiceChannel = await discordClient.channels.fetch(voiceChannel);
        if (!voiceChannel) return null;

        // TODO Load from database.

        const lobby = lobbiesByVoiceChannel.get(voiceChannel.id);
        if (lobby) lobby._voiceChannel = voiceChannel;
        return lobby;
    }

    /**
     * Find a lobby associated with a connect code.
     *
     * @param connectCode
     * @returns {Promise<Lobby|null>}
     */
    static async findByConnectCode(connectCode) {
        if (!connectCode || typeof connectCode !== 'string') return null;
        return lobbiesByConnectCode.get(connectCode);
    }

    constructor({ voiceChannelId, textChannelId, phase, players, room }) {
        if (!voiceChannelId || typeof voiceChannelId !== 'string') throw new Error("Invalid voiceChannelId");
        this.voiceChannelId = voiceChannelId;
        this.textChannelId = textChannelId;

        if (!Object.values(PHASE).includes(phase)) throw new Error("Invalid lobby phase");
        this.phase = phase;

        // Create a map to hold the players.
        this._players = new Map();
        // TODO Add initial players from the constructor.

        // TODO Handle the room properly
        if (room) this.room = room;

        // Create a connect code

        // Generate and link a new code.
        const connectCode = chance.string({ length: 6, casing: 'upper', alpha: true });
        lobbiesByConnectCode.set(connectCode, this);
        this._connectCode = connectCode;

        // Update the connection status
        this.automation = AUTOMATION.WAITING;

        return connectCode;
    }

    /**
     * Get the underlying voice channel for the lobby.
     * @returns {Discord.VoiceChannel}
     */
    get voiceChannel() { return this._voiceChannel; }


    /**
     * Get the text channel used for the lobby.
     * @returns {Discord.TextChannel}
     */
    get textChannel() { return this._textChannel; }

    get players() { return [...this._players.values()];}

    /**
     * @returns {boolean} - Whether or not the lobby is currently transitioning between phases.
     */
    get transitioning() {return Boolean(this._targetPhase);}

    get connectCode() {return this._connectCode;}

    emit(message) {
        console.log(`Lobby ${this.voiceChannelId}: ${message}`);
    }

    async updateAutomationConnection(connected) {
        this.automation = connected ? AUTOMATION.CONNECTED : AUTOMATION.DISCONNECTED;
        await this.postLobbyInfo();
    }

    /**
     * Searches for players in the lobby.
     *
     * @param {Discord.GuildMember|string} member
     * @returns {Promise<Player>}
     */
    async getPlayer(member) {
        return this._players.get(member.id || member);
    }

    /**
     * Connects or reconnects a GuildMember as a player.
     * @param {Discord.GuildMember} member
     * @param {string} [status] - Status for the player to start with.
     * @returns {Promise<Player>} - The player added/updated.
     */
    async connectPlayer(member, status) {
        // Reject string-based connections.
        if (typeof member === 'string') throw new Error("Cannot connect new players via string ID");

        // Ignore bots.
        if (member.user.bot) return null;

        // Load or create a player.
        const playerId = member.id;
        const player = this._players.get(playerId) || new Player(this.voiceChannelId, member, status);
        this._players.set(playerId, player);

        // Update the player's state.
        await this.updatePlayerState(player);

        this.emit(`Connected player ${player.discordName} (${player.discordId})`);
        return player;
    }

    /**
     * Kill the player(s) passed in.
     * Accepts arbitrarily many GuildMembers as arguments.
     *
     * @param {Discord.GuildMember} members
     * @returns {Promise<void>}
     */
    async killPlayer(...members) {
        if (this.phase === PHASE.INTERMISSION) throw new Error("You can't kill people during intermission.");

        // Generate kill orders for each member passed in.
        const killOrders = members.map(async member => {
            // If the member is a player is in this lobby, mark them as dying and update their state.
            const player = await this.getPlayer(member);
            if (player) {
                player.status = Player.STATUS.DYING;
                return this.updatePlayerState(player);
            }
        });

        // Wait for all the kill orders to finish processing.
        await Promise.all(killOrders);

        // If a meeting is already underway, post updated lobby information.
        if (this.phase === PHASE.MEETING) await this.postLobbyInfo();
    }

    /**
     * Revive the player(s) passed in.
     * Accepts arbitrarily many GuildMembers as arguments.
     *
     * @param {Discord.GuildMember} members
     * @returns {Promise<void>}
     */
    async revivePlayer(...members) {
        // Generate revival orders for each member passed in.
        const reviveOrders = members.map(async member => {
            // If the member is a player is in this lobby, mark them as living and update their state.
            const player = await this.getPlayer(member);
            if (player) {
                player.status = Player.STATUS.LIVING;
                return this.updatePlayerState(player);
            }
        });

        // Wait for all the revival orders to finish processing.
        await Promise.all(reviveOrders);

        // If a meeting is already underway, post updated lobby information.
        if (this.phase === PHASE.MEETING) await this.postLobbyInfo();
    }

    async updatePlayerState(player) {
        switch (this.phase) {
            case PHASE.INTERMISSION:
                return player.setForIntermission();
            case PHASE.WORKING:
                return player.setForWorking();
            case PHASE.MEETING:
                return player.setForMeeting();
            default:
                throw new Error("Invalid target phase");
        }
    }

    /**
     * Post information about the lobby to the text channel.
     * @param {object} [options]
     * @param {boolean} [options.spoil] - Display Living and Dying players during the working phase.
     * @returns {module:"discord.js".MessageEmbed}
     */
    async postLobbyInfo(options = {}) {
        const roomInfo = this.room ? `*${this.room.code}* (${this.room.region})` : 'Not Listed';

        const playerInfo = this.players
            .filter(player => player.status !== Player.STATUS.SPECTATING)
            .map(player => {
                const showStatus = options.spoil || this.phase !== PHASE.WORKING || !player.isWorker;
                const status = showStatus ? player.status[0].toUpperCase() + player.status.slice(1) : '_Working_';

                // TODO Load URL from somewhere.
                // const showLink = this.phase !== PHASE.INTERMISSION && workingPhases.includes(player.status);
                // const killUrl = `http://localhost:3000/api/lobby/${this.voiceChannelId}/${player.discordId}/kill`;
                // const killLink = showLink ? ` - [kill](${killUrl})` : '';

                return `<@${player.discordId}> - ${status}`;
            });

        const embed = new MessageEmbed()
            .setTitle(`Among Us - Playing in "${this.voiceChannel.name}"`)
            .addField('Game Phase', this.phase, true)
            .addField('Room Code', roomInfo, true)
            .addField('Players', playerInfo)
            .setFooter(`Capture Status: ${this.automation}`);

        // If there's a text channel bound, send the embed to it.
        if (this.textChannel) {
            await this.deleteLastLobbyInfo();
            this._lastInfoPosted = await this.textChannel.send(embed);
        }

        return embed;
    }

    async deleteLastLobbyInfo() {
        // If there was an old message, delete it.
        if (this._lastInfoPosted && this._lastInfoPosted.deletable) await this._lastInfoPosted.delete();
        delete this._lastInfoPosted;
    }

    async stop() {
        // Unlink the from the "databases".
        lobbiesByVoiceChannel.delete(this.voiceChannelId);
        lobbiesByConnectCode.delete(this._connectCode);

        // Unmute all players.
        await Promise.all(this.players.map(player => player.setMuteDeaf(false, false, "Lobby Stopped")));

        // Delete the last lobby info.
        await this.deleteLastLobbyInfo();

        // Leave the voice channel
        this.voiceChannel.leave();

        this.emit("Destroyed");
    }

    /**
     * Transition to the new phase.
     *
     * @param {string} targetPhase
     * @returns {Promise<void>}
     */
    async transition(targetPhase) {
        // Prevent multiple or duplicate transitions.
        if (this.transitioning) throw new Error("The lobby is already transitioning between phases");
        if (this.phase === targetPhase) throw new Error(`The lobby is already in the ${targetPhase} phase`);
        this._targetPhase = targetPhase;

        // Sort players into batches, to avoid cross-talk.
        const everyone = this.players;
        const workers = everyone.filter(player => player.isWorker);
        const nonWorkers = everyone.filter(player => !player.isWorker);

        // Handle the transition.
        this.emit(`Transitioning to ${targetPhase}`);
        switch (targetPhase) {
            case PHASE.MENU:
                // Delete the room data.
                delete this.room;

            // And perform the same transition as intermission.
            case PHASE.INTERMISSION:
                await Promise.all(everyone.map(player => player.setForIntermission()));
                break;

            case PHASE.WORKING:
                // Update workers first, to avoid cross-talk, then everyone else.
                await Promise.all(workers.map(player => player.setForWorking()));
                await Promise.all(nonWorkers.map(player => player.setForWorking()));
                break;

            case PHASE.MEETING:
                // Update non-workers first, to avoid cross-talk, then everyone else.
                await Promise.all(nonWorkers.map(player => player.setForMeeting()));
                await Promise.all(workers.map(player => player.setForMeeting()));
                break;

            default:
                throw new Error("Invalid target phase");
        }

        this.phase = targetPhase;
        delete this._targetPhase;
        this.emit(`Entered ${targetPhase}`);

        // Send out an update.
        await this.postLobbyInfo();
    }

    toJSON() {
        const { players, room, ...document } = this;
        Object.keys(document)
            .filter(key => key.startsWith('_'))
            .forEach(key => delete document[key]);
        document.players = players.map(player => player.toJSON());
        document.room = room;
        return document;
    }
}

module.exports = Lobby;