const {Client, GatewayIntentBits} = require("discord.js");

// Use environment variables in production, fallback to config.json for local development
let token, targetUserId;

console.log("Checking environment variables...");
console.log("DISCORD_TOKEN exists:", !!process.env.DISCORD_TOKEN);
console.log("TARGET_USER_ID exists:", !!process.env.TARGET_USER_ID);

if (process.env.DISCORD_TOKEN && process.env.TARGET_USER_ID) {
    // Production environment (Railway)
    console.log("Using environment variables");
    token = process.env.DISCORD_TOKEN;
    targetUserId = process.env.TARGET_USER_ID;
} else {
    // Local development
    console.log("Attempting to load config.json...");
    try {
        const config = require("./config.json");
        token = config.token;
        targetUserId = config.targetUserId;
        console.log("Successfully loaded config.json");
    } catch (error) {
        console.error("Environment variables not set and config.json not found!");
        console.error("Please set DISCORD_TOKEN and TARGET_USER_ID environment variables.");
        console.error("Error details:", error.message);
        process.exit(1);
    }
}

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ] 
});

// Bot ready event
client.once('ready', () => {
    console.log(`Bot logged in as ${client.user.tag}!`);
    console.log(`Monitoring voice channels for user ID: ${targetUserId}`);
});

// Voice state update event - triggers when someone joins/leaves/updates voice channel
client.on('voiceStateUpdate', (oldState, newState) => {
    // Check if the state change is for our target user
    if (newState.member.id !== targetUserId) return;
    
    // Check if the user is in a voice channel
    if (!newState.channel) return;
    
    // Check if the user just deafened themselves
    if (!oldState.selfDeaf && newState.selfDeaf) {
        console.log(`Target user ${newState.member.user.tag} has deafened themselves in ${newState.channel.name}`);
        
        // Kick them from the voice channel
        newState.member.voice.disconnect('Auto-kicked for deafening')
            .then(() => {
                console.log(`Successfully kicked ${newState.member.user.tag} from voice channel`);
            })
            .catch(error => {
                console.error(`Failed to kick user: ${error.message}`);
            });
    }
});

// Error handling
client.on('error', error => {
    console.error('Discord client error:', error);
});

client.login(token);