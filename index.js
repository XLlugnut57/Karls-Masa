const {Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActivityType} = require("discord.js");
const http = require('http');

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

// Bot state
let botEnabled = true;

// Function to update bot status
function updateBotStatus() {
    if (botEnabled) {
        client.user.setActivity('👁️ Watching Karl', { type: ActivityType.Custom });
        client.user.setStatus('online');
    } else {
        client.user.setActivity('😴 Sleeping', { type: ActivityType.Custom });
        client.user.setStatus('idle');
    }
    console.log(`Bot status updated: ${botEnabled ? 'MONITORING (Online)' : 'DISABLED (Idle)'}`);
}

// Create HTTP server for Railway health checks
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Discord bot is running!');
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }
});

server.listen(PORT, () => {
    console.log(`Health check server running on port ${PORT}`);
});

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates
    ] 
});

// Register slash commands
const commands = [
    new SlashCommandBuilder()
        .setName('wk')
        .setDescription('Control the voice kick bot')
        .addStringOption(option =>
            option.setName('action')
                .setDescription('Turn the bot on/off or check status')
                .setRequired(true)
                .addChoices(
                    { name: 'on', value: 'on' },
                    { name: 'off', value: 'off' },
                    { name: 'check', value: 'check' }
                ))
];

// Bot ready event
client.once('ready', async () => {
    console.log(`Bot logged in as ${client.user.tag}!`);
    console.log(`Bot ID: ${client.user.id}`);
    console.log(`Monitoring voice channels for user ID: ${targetUserId}`);
    console.log(`Bot status: ${botEnabled ? 'ENABLED' : 'DISABLED'}`);
    
    // Set initial bot status
    updateBotStatus();
    
    // Register slash commands
    const rest = new REST().setToken(token);
    
    try {
        console.log('Started refreshing application (/) commands.');
        
        const data = await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands },
        );
        
        console.log(`Successfully reloaded ${data.length} application (/) commands.`);
        console.log('Commands registered:', data.map(cmd => cmd.name));
    } catch (error) {
        console.error('Error registering slash commands:', error);
        console.error('Error details:', error.code, error.message);
    }
});

// Handle slash commands
client.on('interactionCreate', async interaction => {
    console.log(`Received interaction: ${interaction.type} - ${interaction.commandName}`);
    
    if (!interaction.isChatInputCommand()) return;
    
    if (interaction.commandName === 'wk') {
        console.log(`/wk command used by ${interaction.user.tag} (${interaction.user.id})`);
        
        // Check if the user is the target user (prevent them from using the command)
        if (interaction.user.id === targetUserId) {
            console.log(`Target user ${interaction.user.tag} tried to use /wk command - blocking`);
            await interaction.reply({ 
                content: '🚫 You cannot control this bot!'
            });
            return;
        }
        
        const action = interaction.options.getString('action');
        console.log(`Action: ${action}`);
        
        if (action === 'on') {
            if (botEnabled) {
                await interaction.reply({ 
                    content: '⚠️ Voice kick bot is already **ENABLED**!'
                });
            } else {
                botEnabled = true;
                updateBotStatus();
                await interaction.reply({ 
                    content: '✅ Voice kick bot is now **ENABLED**'
                });
                console.log(`Bot enabled by ${interaction.user.tag}`);
            }
        } else if (action === 'off') {
            if (!botEnabled) {
                await interaction.reply({ 
                    content: '⚠️ Voice kick bot is already **DISABLED**!'
                });
            } else {
                botEnabled = false;
                updateBotStatus();
                await interaction.reply({ 
                    content: '🛑 Voice kick bot is now **DISABLED**'
                });
                console.log(`Bot disabled by ${interaction.user.tag}`);
            }
        } else if (action === 'check') {
            const status = botEnabled ? '**ENABLED** ✅' : '**DISABLED** 🛑';
            const targetUser = await client.users.fetch(targetUserId).catch(() => null);
            const targetName = targetUser ? `${targetUser.tag}` : `User ID: ${targetUserId}`;
            
            await interaction.reply({ 
                content: `📊 **Bot Status:** ${status}\n👤 **Target User:** ${targetName}`
            });
            console.log(`Status checked by ${interaction.user.tag}`);
        }
    }
});

// Voice state update event - triggers when someone joins/leaves/updates voice channel --
client.on('voiceStateUpdate', (oldState, newState) => {
    // Check if bot is disabled
    if (!botEnabled) return;
    
    // Check if the state change is for our target user
    if (newState.member.id !== targetUserId) return;
    
    // Check if the user is in a voice channel
    if (!newState.channel) return;
    
    // Check if user just joined and is already deafened
    if (!oldState.channel && newState.channel && newState.selfDeaf) {
        console.log(`Target user ${newState.member.user.tag} joined ${newState.channel.name} while already deafened`);
        
        // Kick them from the voice channel
        newState.member.voice.disconnect('Auto-kicked for joining while deafened')
            .then(() => {
                console.log(`Successfully kicked ${newState.member.user.tag} from voice channel (joined deafened)`);
            })
            .catch(error => {
                console.error(`Failed to kick user: ${error.message}`);
            });
        return;
    }
    
    // Check if the user just deafened themselves (original functionality)
    if (!oldState.selfDeaf && newState.selfDeaf) {
        console.log(`Target user ${newState.member.user.tag} has deafened themselves in ${newState.channel.name}`);
        
        // Kick them from the voice channel
        newState.member.voice.disconnect('Auto-kicked for deafening')
            .then(() => {
                console.log(`Successfully kicked ${newState.member.user.tag} from voice channel (deafened)`);
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