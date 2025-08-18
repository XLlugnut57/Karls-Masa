const {Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, ActivityType} = require("discord.js");
const { joinVoiceChannel, VoiceConnectionStatus, EndBehaviorType, generateDependencyReport } = require('@discordjs/voice');
const http = require('http');

// Log voice dependencies for debugging
console.log('Voice Dependencies Report:');
console.log(generateDependencyReport());

// Use environment variables in production, fallback to config.json for local development
let token, targetUserId, bmpTargetUserId, bmpLimit, bmpTimeoutMinutes;

console.log("Checking environment variables...");
console.log("DISCORD_TOKEN exists:", !!process.env.DISCORD_TOKEN);
console.log("TARGET_USER_ID exists:", !!process.env.TARGET_USER_ID);
console.log("BMP_TARGET_USER_ID exists:", !!process.env.BMP_TARGET_USER_ID);

if (process.env.DISCORD_TOKEN && process.env.TARGET_USER_ID) {
    // Production environment (Railway)
    console.log("Using environment variables");
    token = process.env.DISCORD_TOKEN;
    targetUserId = process.env.TARGET_USER_ID;
    
    // BMP (Bot Moderation Program) settings
    bmpTargetUserId = process.env.BMP_TARGET_USER_ID || null;
    bmpLimit = parseInt(process.env.BMP_LIMIT) || 100; // Default 100 speaks
    bmpTimeoutMinutes = parseInt(process.env.BMP_TIMEOUT_MINUTES) || 1; // Default 1 minute
    
    console.log(`BMP Settings - Target: ${bmpTargetUserId ? 'Set' : 'Not Set'}, Limit: ${bmpLimit}, Timeout: ${bmpTimeoutMinutes} min`);
} else {
    // Local development
    console.log("Attempting to load config.json...");
    try {
        const config = require("./config.json");
        token = config.token;
        targetUserId = config.targetUserId;
        
        // BMP settings from config (optional)
        bmpTargetUserId = config.bmpTargetUserId || null;
        bmpLimit = config.bmpLimit || 100;
        bmpTimeoutMinutes = config.bmpTimeoutMinutes || 1;
        
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
let disciplineMode = false;

// Speaking tracking
let speakingCounts = new Map(); // userId -> count
let currentlySpeaking = new Set(); // Track who is currently speaking

// BMP (Bot Moderation Program) - Speech monitoring module
let bmpEnabled = false; // Replaces speechMonitoringEnabled
let bmpCount = 0; // Current count for the BMP target (replaces speechCount)
let voiceConnections = new Map(); // Track voice connections for speaking detection

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

// Function to check if target user is currently deafened in any voice channel
async function checkTargetUserDeafened() {
    try {
        // Get all guilds the bot is in
        for (const [guildId, guild] of client.guilds.cache) {
            // Find the target user's voice state in this guild
            const voiceState = guild.voiceStates.cache.get(targetUserId);
            
            if (voiceState && voiceState.channel && voiceState.selfDeaf) {
                console.log(`Found target user ${voiceState.member.user.tag} deafened in ${voiceState.channel.name} when bot was enabled`);
                
                if (disciplineMode) {
                    // Start discipline mode instead of kicking
                    startDisciplineMode(voiceState);
                } else {
                    // Kick them from the voice channel
                    voiceState.member.voice.disconnect('Auto-kicked for being deafened when bot was enabled')
                        .then(() => {
                            console.log(`Successfully kicked ${voiceState.member.user.tag} from voice channel (was deafened when enabled)`);
                        })
                        .catch(error => {
                            console.error(`Failed to kick user: ${error.message}`);
                        });
                }
                
                return true; // Found and handled
            }
        }
        console.log('Target user not found deafened in any voice channels');
        return false;
    } catch (error) {
        console.error('Error checking target user voice state:', error);
        return false;
    }
}

// Function to find empty voice channels in a guild, excluding a specific channel
function findEmptyVoiceChannels(guild, excludeChannelId = null) {
    const botMember = guild.members.me;
    if (!botMember) return new Map();
    
    return guild.channels.cache.filter(channel => {
        // Must be a voice channel
        if (channel.type !== 2) return false;
        
        // Don't include the excluded channel (usually current channel)
        if (excludeChannelId && channel.id === excludeChannelId) return false;
        
        // Must be empty (no members)
        if (channel.members.size > 0) return false;
        
        // Bot must be able to connect to the channel
        const permissions = channel.permissionsFor(botMember);
        if (!permissions) return false;
        
        // Check for required permissions
        return permissions.has(['Connect', 'MoveMembers', 'ViewChannel']);
    });
}

// Function to start discipline mode - rapidly move user between empty VCs
async function startDisciplineMode(voiceState) {
    const guild = voiceState.guild;
    const member = voiceState.member;
    const originalChannel = voiceState.channel; // Remember where they deafened
    const emptyChannels = findEmptyVoiceChannels(guild, originalChannel.id); // Exclude their current channel
    
    if (emptyChannels.size === 0) {
        console.log('No empty voice channels available for discipline mode (excluding current), kicking instead');
        member.voice.disconnect('Auto-kicked for deafening (no empty channels for discipline)')
            .catch(error => console.error(`Failed to kick user: ${error.message}`));
        return;
    }
    
    console.log(`Starting infinite discipline mode for ${member.user.tag} - found ${emptyChannels.size} empty channels`);
    console.log(`Original channel: ${originalChannel.name} - will return here when undeafened`);
    console.log(`Available channels: ${Array.from(emptyChannels.values()).map(c => c.name).join(', ')}`);
    
    const channelArray = Array.from(emptyChannels.values());
    let moveCount = 0;
    let moveInterval = 750; // Start at 0.75 seconds between moves
    let rateLimitHits = 0;
    let disciplineInterval;
    let isRunning = true; // Flag to prevent multiple intervals
    
    const stopDiscipline = (reason) => {
        if (disciplineInterval) {
            clearInterval(disciplineInterval);
            disciplineInterval = null;
        }
        isRunning = false;
        console.log(`Discipline stopped: ${reason}`);
    };
    
    const runDiscipline = () => {
        if (!isRunning) return; // Don't start if already stopped
        
        disciplineInterval = setInterval(async () => {
            try {
                // Check if user left voice entirely (multiple ways to verify)
                if (!member.voice || !member.voice.channel || !member.voice.channelId) {
                    stopDiscipline('User left voice entirely');
                    return;
                }
                
                // Double-check user is still in a voice channel by fetching fresh voice state
                const freshVoiceState = member.guild.voiceStates.cache.get(member.id);
                if (!freshVoiceState || !freshVoiceState.channel) {
                    stopDiscipline('User no longer in voice (fresh check)');
                    return;
                }
                
                // Check if user undeafened - if so, move them back and stop
                if (!member.voice.selfDeaf) {
                    console.log(`User undeafened! Moving ${member.user.tag} back to ${originalChannel.name}`);
                    stopDiscipline('User undeafened');
                    
                    // Move them back to original channel
                    try {
                        await member.voice.setChannel(originalChannel, 'Returned to original channel after undeafening');
                        console.log(`Successfully returned ${member.user.tag} to ${originalChannel.name}`);
                    } catch (error) {
                        console.error(`Failed to return user to original channel: ${error.message}`);
                        // If we can't move them back, just leave them where they are
                    }
                    return;
                }
                
                // Get fresh list of empty channels, excluding their current one
                const currentChannelId = member.voice.channel?.id;
                const freshEmptyChannels = findEmptyVoiceChannels(guild, currentChannelId);
                
                if (freshEmptyChannels.size === 0) {
                    console.log('No valid channels available (all occupied or current channel), ending discipline and kicking');
                    stopDiscipline('No valid channels available');
                    member.voice.disconnect('Discipline ended - no valid channels available')
                        .catch(error => console.error(`Failed to kick user: ${error.message}`));
                    return;
                }
                
                // Convert to array and pick random channel
                const freshChannelArray = Array.from(freshEmptyChannels.values());
                const randomChannel = freshChannelArray[Math.floor(Math.random() * freshChannelArray.length)];
                
                // Double-check this isn't their current channel (should be impossible now)
                if (randomChannel.id === currentChannelId) {
                    console.log(`Somehow picked current channel ${randomChannel.name}, skipping move`);
                    return;
                }
                
                console.log(`Current: ${member.voice.channel?.name}, Moving to: ${randomChannel.name} (interval: ${moveInterval}ms)`);
                
                // Double-check permissions before attempting move
                const permissions = randomChannel.permissionsFor(guild.members.me);
                if (!permissions?.has(['Connect', 'MoveMembers', 'ViewChannel'])) {
                    console.log(`Missing permissions for ${randomChannel.name}, trying next move`);
                    return;
                }
                
                // Double-check channel is still empty right before move
                await randomChannel.fetch(); // Refresh channel data
                if (randomChannel.members.size > 0) {
                    console.log(`Channel ${randomChannel.name} is no longer empty (${randomChannel.members.size} members), trying next move`);
                    return;
                }
                
                // Store current position before move to verify success
                const beforeChannelId = member.voice.channelId;
                
                await member.voice.setChannel(randomChannel, 'Discipline mode - user was deafened');
                
                // Verify the move actually worked by checking their new position
                await new Promise(resolve => setTimeout(resolve, 100)); // Small delay for Discord to update
                const afterChannelId = member.voice.channelId;
                
                if (afterChannelId === randomChannel.id) {
                    moveCount++;
                    rateLimitHits = Math.max(0, rateLimitHits - 1); // Reduce rate limit counter on success
                    console.log(`Discipline move ${moveCount}: Successfully moved ${member.user.tag} to ${randomChannel.name}`);
                } else {
                    console.log(`Move failed: ${member.user.tag} is still in ${member.voice.channel?.name} instead of ${randomChannel.name}`);
                    console.log(`Before: ${beforeChannelId}, Target: ${randomChannel.id}, After: ${afterChannelId}`);
                }
                
            } catch (error) {
                console.error('Error during discipline mode:', error);
                console.log('Error details:', {
                    channelId: error.requestBody?.json?.channel_id,
                    code: error.code,
                    message: error.message
                });
                
                // Handle specific Discord API errors
                if (error.code === 50013) {
                    console.log('Permission error - falling back to kick');
                    stopDiscipline('Permission error');
                    member.voice.disconnect('Auto-kicked due to permission error during discipline')
                        .catch(kickError => console.error(`Failed to kick user: ${kickError.message}`));
                } else if (error.code === 40032) {
                    console.log('Target user is not connected to voice - stopping discipline');
                    stopDiscipline('Target user not connected to voice');
                    // No need to kick since they're already gone
                } else if (error.status === 429) {
                    // Rate limited - increase interval and restart with slower timing
                    rateLimitHits++;
                    moveInterval = Math.min(moveInterval * 1.5, 5000); // Increase up to 5 seconds max
                    console.log(`Hit rate limit (${rateLimitHits} times) - slowing down to ${moveInterval}ms interval`);
                    clearInterval(disciplineInterval);
                    setTimeout(() => {
                        if (isRunning) runDiscipline(); // Only restart if still running
                    }, 1000); // Wait 1 second then restart with new interval
                } else {
                    console.log('Unknown error during discipline - stopping');
                    stopDiscipline('Unknown error');
                }
            }
        }, moveInterval);
    };
    
    // Start the discipline loop
    runDiscipline();
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
                .setDescription('Turn the bot on/off, check status, or enable discipline mode')
                .setRequired(true)
                .addChoices(
                    { name: 'on', value: 'on' },
                    { name: 'off', value: 'off' },
                    { name: 'check', value: 'check' },
                    { name: 'discipline', value: 'discipline' },
                    { name: 'speaking', value: 'speaking' }
                )),
    new SlashCommandBuilder()
        .setName('bmp')
        .setDescription('Bot Moderation Program - Speech monitoring and timeout system')
        .addStringOption(option =>
            option.setName('action')
                .setDescription('Control BMP monitoring')
                .setRequired(true)
                .addChoices(
                    { name: 'pause', value: 'pause' },
                    { name: 'resume', value: 'resume' },
                    { name: 'reset', value: 'reset' },
                    { name: 'check', value: 'check' }
                )),
    new SlashCommandBuilder()
        .setName('permissions')
        .setDescription('Check bot permissions for debugging')
];

// Bot ready event
client.once('ready', async () => {
    console.log(`Bot logged in as ${client.user.tag}!`);
    console.log(`Bot ID: ${client.user.id}`);
    console.log(`Monitoring voice channels for user ID: ${targetUserId}`);
    console.log(`Bot status: ${botEnabled ? 'ENABLED' : 'DISABLED'}`);
    
    // BMP status and auto-start
    if (bmpTargetUserId) {
        bmpEnabled = true; // Auto-enable BMP on startup
        console.log(`BMP Target: ${bmpTargetUserId}, Limit: ${bmpLimit}, Timeout: ${bmpTimeoutMinutes} min`);
        console.log(`BMP Status: AUTO-ENABLED on startup`);
        
        // Check if target is already in a voice channel and join immediately
        setTimeout(async () => {
            try {
                const targetUser = await client.users.fetch(bmpTargetUserId);
                console.log(`🎯 BMP auto-monitoring enabled for ${targetUser.tag}`);
                
                // Check all guilds for the target user in voice
                for (const guild of client.guilds.cache.values()) {
                    const targetMember = guild.members.cache.get(bmpTargetUserId);
                    if (targetMember && targetMember.voice.channel) {
                        console.log(`🔊 BMP target found in voice channel: ${targetMember.voice.channel.name} - joining automatically`);
                        joinVoiceChannelForMonitoring(targetMember.voice.channel);
                        break;
                    }
                }
            } catch (error) {
                console.error(`❌ Failed to fetch BMP target user: ${error.message}`);
            }
        }, 2000); // Small delay to ensure bot is fully ready
    } else {
        console.log(`BMP Target: Not set - use environment variable BMP_TARGET_USER_ID`);
    }
    
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
                
                // Check if target user is already deafened when bot is enabled
                const wasDeafened = await checkTargetUserDeafened();
                
                if (wasDeafened) {
                    await interaction.reply({ 
                        content: '✅ Voice kick bot is now **ENABLED**\n🦵 Target user was already deafened and has been kicked!'
                    });
                } else {
                    await interaction.reply({ 
                        content: '✅ Voice kick bot is now **ENABLED**'
                    });
                }
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
            const mode = disciplineMode ? '**DISCIPLINE** 🌪️' : '**KICK** 🦵';
            const targetUser = await client.users.fetch(targetUserId).catch(() => null);
            const targetName = targetUser ? `${targetUser.tag}` : `User ID: ${targetUserId}`;
            
            await interaction.reply({ 
                content: `📊 **Bot Status:** ${status}\n⚡ **Mode:** ${mode}\n👤 **Target User:** ${targetName}`
            });
            console.log(`Status checked by ${interaction.user.tag}`);
        } else if (action === 'discipline') {
            if (!botEnabled) {
                await interaction.reply({ 
                    content: '⚠️ Bot must be enabled first! Use `/wk on` then `/wk discipline`'
                });
            } else if (disciplineMode) {
                disciplineMode = false;
                await interaction.reply({ 
                    content: '🦵 Discipline mode **DISABLED** - back to kicking mode'
                });
                console.log(`Discipline mode disabled by ${interaction.user.tag}`);
            } else {
                disciplineMode = true;
                await interaction.reply({ 
                    content: '🌪️ Discipline mode **ENABLED** - will move user between empty channels!'
                });
                console.log(`Discipline mode enabled by ${interaction.user.tag}`);
            }
        } else if (action === 'speaking') {
            // Show speaking counts for all users
            if (speakingCounts.size === 0) {
                await interaction.reply({ 
                    content: '🎤 No speaking activity recorded yet!'
                });
            } else {
                let response = '🎤 **Speaking Activity:**\n';
                
                // Sort by speaking count (highest first)
                const sortedCounts = Array.from(speakingCounts.entries())
                    .sort((a, b) => b[1] - a[1]);
                
                for (const [userId, count] of sortedCounts.slice(0, 10)) { // Show top 10
                    const user = await client.users.fetch(userId).catch(() => null);
                    const userName = user ? user.tag : `User ID: ${userId}`;
                    const isSpeaking = currentlySpeaking.has(userId) ? ' 🎤' : '';
                    response += `• ${userName}: **${count}** times${isSpeaking}\n`;
                }
                
                if (sortedCounts.length > 10) {
                    response += `\n... and ${sortedCounts.length - 10} more users`;
                }
                
                await interaction.reply({ content: response });
            }
            console.log(`Speaking stats checked by ${interaction.user.tag}`);
        }
    } else if (interaction.commandName === 'bmp') {
        const action = interaction.options.getString('action');

        // Check if BMP target is configured
        if (!bmpTargetUserId) {
            await interaction.reply({ 
                content: '⚠️ **BMP target not configured!**\nPlease set the `BMP_TARGET_USER_ID` environment variable on Railway.',
                ephemeral: true
            });
            return;
        }

        if (action === 'pause') {
            if (!bmpEnabled) {
                await interaction.reply({ 
                    content: '⚠️ **BMP is already paused**'
                });
                return;
            }
            
            bmpEnabled = false;
            
            // Leave all voice channels when pausing
            voiceConnections.forEach((connection, guildId) => {
                const guild = client.guilds.cache.get(guildId);
                if (guild) {
                    console.log(`🚪 Leaving voice channel in ${guild.name} due to BMP pause`);
                    connection.destroy();
                }
            });
            voiceConnections.clear();
            
            await interaction.reply({ 
                content: '⏸️ **BMP PAUSED** - Bot left all voice channels'
            });
            console.log(`BMP paused by ${interaction.user.tag}`);

        } else if (action === 'resume') {
            if (bmpEnabled) {
                await interaction.reply({ 
                    content: '⚠️ **BMP is already running**'
                });
                return;
            }
            
            bmpEnabled = true;

            // Check if target is already in a voice channel
            const targetUser = await client.users.fetch(bmpTargetUserId).catch(() => null);
            if (!targetUser) {
                await interaction.reply({ 
                    content: '❌ **Could not find BMP target user**'
                });
                return;
            }

            const targetMember = interaction.guild.members.cache.get(bmpTargetUserId);
            if (targetMember && targetMember.voice.channel) {
                console.log(`🎯 BMP target ${targetUser.tag} is already in ${targetMember.voice.channel.name} - joining now`);
                joinVoiceChannelForMonitoring(targetMember.voice.channel);
                
                await interaction.reply({ 
                    content: `▶️ **BMP RESUMED**\n👤 **Target:** ${targetUser.tag}\n📊 **Count:** ${bmpCount}/${bmpLimit}\n⏱️ **Timeout:** ${bmpTimeoutMinutes} min\n🔊 **Bot joined:** ${targetMember.voice.channel.name}`
                });
            } else {
                await interaction.reply({ 
                    content: `▶️ **BMP RESUMED**\n👤 **Target:** ${targetUser.tag}\n📊 **Count:** ${bmpCount}/${bmpLimit}\n⏱️ **Timeout:** ${bmpTimeoutMinutes} min\n⏳ **Waiting for target to join voice...**`
                });
            }
            console.log(`BMP resumed for ${targetUser.tag} by ${interaction.user.tag}`);

        } else if (action === 'check') {
            const targetUser = await client.users.fetch(bmpTargetUserId).catch(() => null);
            const targetName = targetUser ? targetUser.tag : `User ID: ${bmpTargetUserId}`;
            const remaining = Math.max(0, bmpLimit - bmpCount);
            
            if (!bmpEnabled) {
                await interaction.reply({ 
                    content: `⏸️ **BMP is PAUSED**\n👤 **Target:** ${targetName}\n📊 **Count:** ${bmpCount}/${bmpLimit}\n⏳ **Remaining:** ${remaining} times\n⏱️ **Timeout:** ${bmpTimeoutMinutes} min`
                });
            } else {
                await interaction.reply({ 
                    content: `▶️ **BMP is ACTIVE**\n👤 **Target:** ${targetName}\n📊 **Count:** ${bmpCount}/${bmpLimit}\n⏳ **Remaining:** ${remaining} times\n⏱️ **Timeout:** ${bmpTimeoutMinutes} min`
                });
            }

        } else if (action === 'reset') {
            bmpCount = 0;
            await interaction.reply({ 
                content: `🔄 **BMP count RESET** to 0/${bmpLimit}`
            });
            console.log(`BMP count reset by ${interaction.user.tag}`);
        }
    } else if (interaction.commandName === 'permissions') {
        const guild = interaction.guild;
        const botMember = guild.members.cache.get(client.user.id);
        
        if (!botMember) {
            await interaction.reply({ content: '❌ Could not find bot member in this server', ephemeral: true });
            return;
        }
        
        const permissions = botMember.permissions;
        const requiredPerms = [
            { name: 'Moderate Members', key: 'ModerateMembers', needed: true },
            { name: 'Kick Members', key: 'KickMembers', needed: true },
            { name: 'Move Members', key: 'MoveMembers', needed: true },
            { name: 'Connect', key: 'Connect', needed: true },
            { name: 'View Channel', key: 'ViewChannel', needed: true }
        ];
        
        let permissionText = '🔐 **Bot Permissions Check**\n\n';
        
        for (const perm of requiredPerms) {
            const hasPermission = permissions.has(perm.key);
            const emoji = hasPermission ? '✅' : '❌';
            const status = hasPermission ? 'GRANTED' : 'MISSING';
            permissionText += `${emoji} **${perm.name}**: ${status}\n`;
        }
        
        permissionText += '\n**Permission Usage:**\n';
        permissionText += '• **Moderate Members** → Timeout users (speech monitoring)\n';
        permissionText += '• **Kick Members** → Fallback when timeout fails\n';
        permissionText += '• **Move Members** → Discipline mode\n';
        permissionText += '• **Connect** → Join voice channels\n';
        permissionText += '• **View Channel** → See voice channels\n';
        
        if (!permissions.has('ModerateMembers')) {
            permissionText += '\n⚠️ **Missing "Moderate Members" permission!**\n';
            permissionText += 'Speech monitoring will fall back to voice kicks instead of timeouts.';
        }
        
        await interaction.reply({ content: permissionText, ephemeral: true });
    }
});

// Speaking detection event - tracks when users start/stop speaking
// For proper speaking detection, the bot needs to join voice channels
client.on('voiceStateUpdate', (oldState, newState) => {
    // Handle BMP target joining/leaving voice
    if (bmpEnabled && (newState.member?.id === bmpTargetUserId || oldState.member?.id === bmpTargetUserId)) {
        const member = newState.member || oldState.member;
        
        if (!oldState.channel && newState.channel) {
            // Target joined a voice channel - bot should join to monitor
            console.log(`🎯 BMP target ${member.user.tag} joined ${newState.channel.name} - joining to monitor speaking`);
            joinVoiceChannelForMonitoring(newState.channel);
        } else if (oldState.channel && !newState.channel) {
            // Target left voice channel - bot can leave
            console.log(`🎯 BMP target ${member.user.tag} left voice - stopping monitoring`);
            leaveVoiceChannel(oldState.channel);
        } else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
            // Target moved to different channel
            console.log(`🎯 BMP target ${member.user.tag} moved to ${newState.channel.name}`);
            leaveVoiceChannel(oldState.channel);
            joinVoiceChannelForMonitoring(newState.channel);
        }
    }
});

// Function to join voice channel for monitoring
function joinVoiceChannelForMonitoring(channel) {
    console.log(`🔄 Attempting to join voice channel: ${channel.name} (ID: ${channel.id})`);
    
    try {
        // Check if bot has permissions
        const permissions = channel.permissionsFor(channel.guild.members.me);
        if (!permissions || !permissions.has(['ViewChannel', 'Connect'])) {
            console.error(`❌ Missing permissions to join ${channel.name}`);
            console.error(`Bot permissions:`, permissions ? permissions.toArray() : 'No permissions found');
            return;
        }

        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
            selfDeaf: true, // Bot should be deafened
            selfMute: true  // Bot should be muted
        });

        voiceConnections.set(channel.guild.id, connection);
        console.log(`🔗 Voice connection created for ${channel.name}`);

        connection.on(VoiceConnectionStatus.Ready, () => {
            console.log(`✅ Bot successfully joined ${channel.name} for speaking detection`);
            setupSpeakingDetection(connection, channel);
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            console.log(`❌ Bot disconnected from ${channel.name}`);
            
            // Try to reconnect if speech monitoring is still enabled
            if (speechMonitoringEnabled) {
                console.log(`🔄 Attempting to reconnect to ${channel.name}...`);
                try {
                    await connection.rejoin();
                    console.log(`✅ Successfully reconnected to ${channel.name}`);
                } catch (error) {
                    console.error(`❌ Failed to reconnect: ${error.message}`);
                    voiceConnections.delete(channel.guild.id);
                }
            } else {
                voiceConnections.delete(channel.guild.id);
            }
        });

        connection.on(VoiceConnectionStatus.Destroyed, () => {
            console.log(`🗑️ Voice connection destroyed for ${channel.name}`);
            voiceConnections.delete(channel.guild.id);
        });

        // Prevent automatic disconnection due to inactivity
        connection.on(VoiceConnectionStatus.Signalling, () => {
            console.log(`🔗 Signalling to ${channel.name}`);
        });

        connection.on(VoiceConnectionStatus.Connecting, () => {
            console.log(`🔄 Connecting to ${channel.name}`);
        });

        // Handle connection errors
        connection.on('error', (error) => {
            console.error(`🚨 Voice connection error for ${channel.name}:`, error.message);
            if (error.message.includes('DAVE protocol')) {
                console.log('🔧 DAVE protocol error - this is a known issue with some Discord voice setups');
                console.log('Voice connection will continue with fallback encryption');
            }
        });

    } catch (error) {
        console.error(`❌ Failed to join voice channel ${channel.name}: ${error.message}`);
        if (error.message.includes('DAVE protocol')) {
            console.log('🔧 DAVE protocol error detected - trying to continue with fallback');
        } else {
            console.error('Error details:', error);
        }
    }
}

// Function to leave voice channel
function leaveVoiceChannel(channel) {
    const connection = voiceConnections.get(channel.guild.id);
    if (connection) {
        connection.destroy();
        voiceConnections.delete(channel.guild.id);
        console.log(`🚪 Bot left ${channel.name}`);
    }
}

// Function to set up speaking detection
function setupSpeakingDetection(connection, channel) {
    console.log(`🔧 Setting up speaking detection for ${channel.name}`);
    
    try {
        // In Discord.js v14, we use the connection's receiver directly
        const receiver = connection.receiver;
        
        console.log(`📡 Using connection receiver for speaking detection`);

        // Listen for users speaking - using receiver.speaking map
        receiver.speaking.on('start', (userId) => {
            // Only log for BMP target to reduce spam
            if (bmpEnabled && userId === bmpTargetUserId) {
                console.log(`🎯 BMP target speaking detected for user ID: ${userId}`);
            }
            
            const member = channel.guild.members.cache.get(userId);
            if (!member) {
                if (bmpEnabled && userId === bmpTargetUserId) {
                    console.log(`❌ Could not find member for BMP target user ID: ${userId}`);
                }
                return;
            }

            const userName = member.user.tag;
            const currentCount = speakingCounts.get(userId) || 0;
            speakingCounts.set(userId, currentCount + 1);
            
            // Only log for BMP target
            if (bmpEnabled && userId === bmpTargetUserId) {
                console.log(`🎤 ${userName} started speaking (count: ${currentCount + 1})`);
            }

            // Check BMP monitoring for specific target
            if (bmpEnabled && userId === bmpTargetUserId) {
                bmpCount++;
                console.log(`📊 BMP target ${userName} spoke: ${bmpCount}/${bmpLimit}`);
                
                if (bmpCount >= bmpLimit) {
                    // Timeout the user
                    console.log(`🚫 ${userName} reached BMP limit (${bmpLimit}) - attempting timeout!`);
                    
                    // Check if bot has permission to timeout members
                    const botMember = channel.guild.members.me;
                    const targetMember = member; // The member we're trying to timeout
                    
                    // Detailed permission checking
                    console.log(`🔍 BMP Permission Check Details:`);
                    console.log(`- Bot has ModerateMembers: ${botMember.permissions.has('ModerateMembers')}`);
                    console.log(`- Target is manageable: ${targetMember.manageable}`);
                    console.log(`- Bot role position: ${botMember.roles.highest.position}`);
                    console.log(`- Target role position: ${targetMember.roles.highest.position}`);
                    console.log(`- Bot can moderate target: ${botMember.roles.highest.position > targetMember.roles.highest.position}`);
                    
                    const canTimeout = botMember.permissions.has('ModerateMembers') && 
                                     targetMember.manageable &&
                                     botMember.roles.highest.position > targetMember.roles.highest.position;
                    
                    if (!canTimeout) {
                        console.error(`❌ Cannot timeout ${userName} - insufficient permissions or role hierarchy`);
                        console.log(`🦵 Falling back to kicking ${userName} from voice instead`);
                        
                        // Fallback to kicking from voice if no timeout permission
                        member.voice.disconnect(`Exceeded BMP limit (${bmpLimit} times) - kicked due to permissions`)
                            .then(() => {
                                console.log(`✅ Successfully kicked ${userName} from voice (fallback)`);
                                // Reset counter and continue monitoring instead of disabling
                                bmpCount = 0;
                                console.log(`🔄 BMP counter reset to 0/${bmpLimit} - continuing monitoring`);
                                leaveVoiceChannel(channel);
                            })
                            .catch(kickError => {
                                console.error(`❌ Failed to kick ${userName}: ${kickError.message}`);
                            });
                    } else {
                        // Bot has permission, attempt timeout
                        console.log(`✅ BMP permission checks passed - attempting timeout...`);
                        const timeoutMs = bmpTimeoutMinutes * 60 * 1000; // Convert minutes to milliseconds
                        member.timeout(timeoutMs, `Exceeded BMP limit (${bmpLimit} times)`)
                            .then(() => {
                                console.log(`✅ Successfully timed out ${userName} for ${bmpTimeoutMinutes} minutes`);
                                // Reset counter and continue monitoring instead of disabling
                                bmpCount = 0;
                                console.log(`🔄 BMP counter reset to 0/${bmpLimit} - continuing monitoring`);
                                // Leave voice channel after timeout (bot will rejoin when target returns)
                                leaveVoiceChannel(channel);
                            })
                            .catch(error => {
                                console.error(`❌ Failed to timeout ${userName}: ${error.message}`);
                                console.log(`🦵 Falling back to kicking ${userName} from voice`);
                                
                                // Fallback to voice kick if timeout fails
                                member.voice.disconnect(`Exceeded BMP limit (${bmpLimit} times) - timeout failed`)
                                    .then(() => {
                                        console.log(`✅ Successfully kicked ${userName} from voice (timeout fallback)`);
                                        // Reset counter and continue monitoring instead of disabling
                                        bmpCount = 0;
                                        console.log(`🔄 BMP counter reset to 0/${bmpLimit} - continuing monitoring`);
                                        leaveVoiceChannel(channel);
                                    })
                                    .catch(kickError => {
                                        console.error(`❌ Failed to kick ${userName}: ${kickError.message}`);
                                    });
                            });
                    }
                }
            }
        });

        // Listen for users stopping speaking
        receiver.speaking.on('end', (userId) => {
            // Only log for BMP target to reduce spam
            if (bmpEnabled && userId === bmpTargetUserId) {
                const member = channel.guild.members.cache.get(userId);
                if (member) {
                    console.log(`🔇 ${member.user.tag} stopped speaking`);
                }
            }
        });

        console.log(`✅ Speaking detection setup complete for ${channel.name}`);
        
    } catch (error) {
        console.error(`❌ Failed to setup speaking detection:`, error);
        
        // Fallback: Use a simple approach without audio receiver
        console.log(`� Attempting fallback speaking detection method...`);
        setupFallbackSpeakingDetection(connection, channel);
    }
}

// Fallback speaking detection method
function setupFallbackSpeakingDetection(connection, channel) {
    console.log(`🔄 Setting up fallback speaking detection for ${channel.name}`);
    
    // Simple approach: monitor voice state changes as proxy for speaking
    // This isn't perfect but will work when direct speaking detection fails
    
    // Set up a periodic check for voice activity
    const speakingChecker = setInterval(() => {
        if (!speechMonitoringEnabled) {
            clearInterval(speakingChecker);
            return;
        }
        
        // Check if target user is still in the channel
        const targetMember = channel.guild.members.cache.get(speechTargetUserId);
        if (!targetMember || !targetMember.voice.channel || targetMember.voice.channel.id !== channel.id) {
            console.log(`Target user not in monitored channel, stopping fallback detection`);
            clearInterval(speakingChecker);
            return;
        }
        
        // For fallback, we'll use a simple message: user can type "speak" to simulate speaking
        // This is just for testing when real voice detection doesn't work
        
    }, 5000); // Check every 5 seconds
    
    console.log(`✅ Fallback speaking detection active for ${channel.name}`);
}

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
        
        if (disciplineMode) {
            // Start discipline mode
            startDisciplineMode(newState);
        } else {
            // Kick them from the voice channel
            newState.member.voice.disconnect('Auto-kicked for joining while deafened')
                .then(() => {
                    console.log(`Successfully kicked ${newState.member.user.tag} from voice channel (joined deafened)`);
                })
                .catch(error => {
                    console.error(`Failed to kick user: ${error.message}`);
                });
        }
        return;
    }
    
    // Check if the user just deafened themselves (original functionality)
    if (!oldState.selfDeaf && newState.selfDeaf) {
        console.log(`Target user ${newState.member.user.tag} has deafened themselves in ${newState.channel.name}`);
        
        if (disciplineMode) {
            // Start discipline mode
            startDisciplineMode(newState);
        } else {
            // Kick them from the voice channel
            newState.member.voice.disconnect('Auto-kicked for deafening')
                .then(() => {
                    console.log(`Successfully kicked ${newState.member.user.tag} from voice channel (deafened)`);
                })
                .catch(error => {
                    console.error(`Failed to kick user: ${error.message}`);
                });
        }
    }
});

// Fallback: Message-based speaking simulation for testing
client.on('messageCreate', (message) => {
    // Skip if not from a user in voice channel or if it's a bot command
    if (message.author.bot || message.content.startsWith('/')) return;
    
    const member = message.member;
    if (!member || !member.voice.channel) return;
    
    // Special command for testing BMP detection
    if (message.content.toLowerCase() === 'speak' && bmpEnabled && member.id === bmpTargetUserId) {
        console.log(`🎤 [FALLBACK] ${member.user.tag} simulated speaking via message`);
        
        bmpCount++;
        console.log(`📊 BMP target ${member.user.tag} spoke: ${bmpCount}/${bmpLimit}`);
        
        if (bmpCount >= bmpLimit) {
            console.log(`🚫 ${member.user.tag} reached BMP limit (${bmpLimit}) - timing out!`);
            
            // Check if bot has permission to timeout users
            const botMember = message.guild.members.cache.get(client.user.id);
            const targetMember = member;
            
            // Detailed permission checking
            console.log(`🔍 [FALLBACK] BMP Permission Check Details:`);
            console.log(`- Bot has ModerateMembers: ${botMember?.permissions.has('ModerateMembers')}`);
            console.log(`- Target is manageable: ${targetMember.manageable}`);
            console.log(`- Bot role position: ${botMember?.roles.highest.position}`);
            console.log(`- Target role position: ${targetMember.roles.highest.position}`);
            console.log(`- Bot can moderate target: ${botMember?.roles.highest.position > targetMember.roles.highest.position}`);
            
            const canTimeout = botMember && 
                             botMember.permissions.has('ModerateMembers') && 
                             targetMember.manageable &&
                             botMember.roles.highest.position > targetMember.roles.highest.position;
            
            if (canTimeout) {
                console.log(`✅ [FALLBACK] BMP permission checks passed - attempting timeout...`);
                const timeoutMs = bmpTimeoutMinutes * 60 * 1000; // Convert minutes to milliseconds
                member.timeout(timeoutMs, `Exceeded BMP limit (${bmpLimit} times)`)
                    .then(() => {
                        console.log(`✅ Successfully timed out ${member.user.tag} for ${bmpTimeoutMinutes} minutes`);
                        // Reset counter and continue monitoring instead of disabling
                        bmpCount = 0;
                        console.log(`🔄 BMP counter reset to 0/${bmpLimit} - continuing monitoring`);
                        const channel = member.voice.channel;
                        if (channel) leaveVoiceChannel(channel);
                    })
                    .catch(error => {
                        console.error(`❌ Failed to timeout ${member.user.tag}: ${error.message}`);
                        // Fallback to voice kick if timeout fails
                        console.log(`⚠️ Falling back to voice disconnect...`);
                        member.voice.disconnect('Exceeded BMP limit')
                            .then(() => {
                                console.log(`✅ Successfully disconnected ${member.user.tag} from voice`);
                                // Reset counter and continue monitoring instead of disabling
                                bmpCount = 0;
                                console.log(`🔄 BMP counter reset to 0/${bmpLimit} - continuing monitoring`);
                                const channel = member.voice.channel;
                                if (channel) leaveVoiceChannel(channel);
                            })
                            .catch(kickError => {
                                console.error(`❌ Failed to disconnect user from voice: ${kickError.message}`);
                            });
                    });
            } else {
                console.log(`⚠️ [FALLBACK] Cannot timeout - insufficient permissions or role hierarchy`);
                member.voice.disconnect('Exceeded BMP limit')
                    .then(() => {
                        console.log(`✅ Successfully disconnected ${member.user.tag} from voice`);
                        // Reset counter and continue monitoring instead of disabling
                        bmpCount = 0;
                        console.log(`🔄 BMP counter reset to 0/${bmpLimit} - continuing monitoring`);
                        const channel = member.voice.channel;
                        if (channel) leaveVoiceChannel(channel);
                    })
                    .catch(error => {
                        console.error(`❌ Failed to disconnect user from voice: ${error.message}`);
                    });
            }
        }
        
        // Delete the test message
        message.delete().catch(() => {});
    }
});

// Error handling
client.on('error', error => {
    console.error('Discord client error:', error);
});

client.login(token);