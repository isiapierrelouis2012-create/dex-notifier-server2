const WebSocket = require('ws');
const http = require('http');
const fetch = require('node-fetch');

// ========== CONFIG ==========
// Replace these with your actual Discord webhook URLs
const WEBHOOK_LOW = 'https://discord.com/api/webhooks/1527730391392194660/X07VLy1EPcOmn_Dg-m66T9QNFxvvtdTANCNCbPR_d29rRGJOI5BBpHw9qnIiDGhFxiZ1';
const WEBHOOK_MID = 'https://discord.com/api/webhooks/1527730631193268254/007lqz_W1_3LZEndLW6BYPOZE_K4wv-5V1riLNw7ndIf8G7Ka55D5PE-lMyic4b0hsFh';
const WEBHOOK_HIGH = 'https://discord.com/api/webhooks/1527730865411588118/DyJs_qJYlriOuCcIwe5UqkqPtDsxpWkoH1inwAdRXojWOrnxIVs1Pf8X1wRJtc63hZiF';
const WEBHOOK_AUTOJOIN = WEBHOOK_HIGH; // or use a separate webhook

const PLACE_ID = 109983668079237; // The game ID

// ========== DEX NOTIFIER SYSTEM CONFIG ==========
const CONFIG_URL = 'https://dexnotifiersystems.up.railway.app/secure';

// ========== STATE ==========
const clients = new Map(); // ws -> { username }
let masterWSS = null;
let dexWs = null;
let reconnectTimer = null;

// ========== HELPERS ==========
function fmtVal(n) {
    n = Number(n) || 0;
    const units = ['K', 'M', 'B', 'T'];
    let i = -1;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
    if (i === -1) return '$' + Math.floor(n) + '/s';
    return '$' + n.toFixed(1) + units[i] + '/s';
}

function getDateStr() {
    const d = new Date();
    const hr12 = d.getHours() % 12 || 12;
    const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
    return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}, ${hr12}:${String(d.getMinutes()).padStart(2,'0')} ${ampm}`;
}

async function sendDiscordWebhook(url, embed) {
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        });
        if (!response.ok) console.error(`Webhook failed: ${response.status}`);
    } catch (e) {
        console.error('Webhook error:', e.message);
    }
}

function sendTierWebhook(name, generation, owner, jobId, ogFlag) {
    const valNum = Number(generation) || 0;
    let webhook;
    if (valNum < 50e6) webhook = WEBHOOK_LOW;
    else if (valNum < 700e6) webhook = WEBHOOK_MID;
    else webhook = WEBHOOK_HIGH;

    const cleanName = String(name).replace(/\$[\d.]+[KMBT]?\/[Ss]/g, '').replace(/\$[\d.]+[KMBT]?/g, '').trim();
    const shortGen = fmtVal(valNum) + (ogFlag ? ' 🏅OG' : '');

    const color = valNum < 50e6 ? 0x00aaff : (valNum < 700e6 ? 0xffaa00 : 0xff5500);

    const embed = {
        title: `Highlight: ${cleanName} Detected`,
        color: color,
        fields: [
            { name: 'Name', value: cleanName, inline: true },
            { name: 'Money', value: shortGen, inline: true },
            { name: 'Owner', value: `\`${owner || 'Unknown'}\``, inline: true },
            { name: 'Job ID', value: `\`${jobId || 'N/A'}\``, inline: false },
            { name: 'Shop', value: '[petmart.fun](https://petmart.fun) — always in stock, instant delivery', inline: false },
        ],
        footer: { text: `Base Finder · discord.gg/stealarot · ${getDateStr()}` },
        timestamp: new Date().toISOString(),
    };
    sendDiscordWebhook(webhook, embed);

    // Extra 1B+ embed
    if (valNum >= 1e9) {
        const serverEmbed = {
            title: '1B+ Server Detected',
            color: 0xff5500,
            description: `**${cleanName}** · ${shortGen}`,
            footer: { text: `Base Finder · discord.gg/stealarot · ${getDateStr()}` },
            timestamp: new Date().toISOString(),
        };
        sendDiscordWebhook(webhook, serverEmbed);
    }
}

function sendAutoJoinNotification(name, money, owner, jobId) {
    const notifierUrl = `https://liphyrdev.github.io/notifier/?placeId=${PLACE_ID}&gameInstanceId=${jobId}`;
    const embed = {
        title: '🚀 Auto‑Join Triggered',
        color: 0x00ff88,
        fields: [
            { name: 'Brainrot', value: String(name), inline: true },
            { name: 'Money', value: fmtVal(money), inline: true },
            { name: 'Owner', value: `\`${owner || 'Unknown'}\``, inline: true },
            { name: 'Job ID', value: `\`${jobId || 'N/A'}\``, inline: false },
            { name: 'Join Server', value: `[Click here to join](${notifierUrl})`, inline: false },
        ],
        footer: { text: `Auto‑Join · ${getDateStr()}` },
        timestamp: new Date().toISOString(),
    };
    sendDiscordWebhook(WEBHOOK_AUTOJOIN, embed);
}

// ========== BROADCAST TO ALL CLIENTS ==========
function broadcastUsers() {
    const userNames = [];
    for (const [, info] of clients) {
        if (info.username && info.username !== 'Unknown') userNames.push(info.username);
    }
    const payload = JSON.stringify({ type: 'users', users: userNames });
    for (const [client] of clients) {
        try { client.send(payload); } catch(e) {}
    }
}

function broadcastLog(message, data) {
    const payload = JSON.stringify({ type: 'log', message, data });
    for (const [client] of clients) {
        try { client.send(payload); } catch(e) {}
    }
}

// ========== DEX NOTIFIER WEBSOCKET CONNECTION ==========
async function connectToDex() {
    if (dexWs && dexWs.readyState === WebSocket.OPEN) return;

    // Fetch the master WSS URL
    try {
        const resp = await fetch(CONFIG_URL);
        const config = await resp.json();
        masterWSS = config.wss;
        if (!masterWSS) throw new Error('No wss in config');
    } catch (e) {
        console.error('Failed to fetch Dex config:', e.message);
        scheduleReconnect(5);
        return;
    }

    console.log(`Connecting to Dex WSS: ${masterWSS}`);
    dexWs = new WebSocket(masterWSS);

    dexWs.on('open', () => {
        console.log('[Dex] Connected to WSS');
    });

    dexWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'spotting') {
                const pet = msg.pet || {};
                const name = pet.display_name || msg.raw_name || 'Unknown';
                const generation = msg.generation || 0;
                const owner = msg.owner_username || 'Unknown';
                let jobId = msg.job_id || '';
                // If jobId is encrypted, you can add decryption here if needed
                const ogFlag = msg.og || pet.og || false;

                // 1. Send Discord webhooks
                sendTierWebhook(name, generation, owner, jobId, ogFlag);

                // 2. Broadcast to all connected Roblox clients
                const logMsg = `[${getDateStr()}] ${name} - ${fmtVal(generation)}`;
                broadcastLog(logMsg, { name, generation, owner, jobId, ogFlag });

                console.log(`[Dex] Detection: ${name} - ${fmtVal(generation)}`);
            }
        } catch (e) {
            console.error('Error processing Dex message:', e);
        }
    });

    dexWs.on('close', () => {
        console.log('[Dex] Disconnected, reconnecting...');
        scheduleReconnect(3);
    });

    dexWs.on('error', (err) => {
        console.error('[Dex] Error:', err.message);
        dexWs.close();
    });
}

function scheduleReconnect(seconds) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToDex();
    }, seconds * 1000);
}

// ========== WEBSOCKET SERVER FOR ROBLOX CLIENTS ==========
const wss = new WebSocket.Server({ port: 8080 });
console.log('WebSocket server running on ws://localhost:8080');

// Optional HTTP status page
const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h1>Dex Notifier Server</h1><p>Connected clients: ${clients.size}</p>`);
});
httpServer.listen(3000, () => {
    console.log('HTTP status page on http://localhost:3000');
});

wss.on('connection', (ws) => {
    const clientInfo = { username: 'Unknown' };
    clients.set(ws, clientInfo);
    console.log(`[Client] Connected. Total: ${clients.size}`);

    // Send initial user list
    broadcastUsers();

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        // Update username
        if (data.name) {
            clientInfo.username = data.name;
            broadcastUsers();
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        broadcastUsers();
        console.log(`[Client] Disconnected. Total: ${clients.size}`);
    });
});

// ========== START ==========
connectToDex();

console.log('Server started. Press Ctrl+C to stop.');