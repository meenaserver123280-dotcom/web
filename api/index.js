// api/index.js

const express = require('express');
const fetch = require('node-fetch');
const requestIp = require('request-ip');
const mongoose = require('mongoose');
const path = require('path');

const app = express();

app.use(express.json());
app.use(requestIp.mw());

// Serve static HTML
app.use(express.static(path.join(__dirname, '../public')));

/* =========================
ROOT
========================= */
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

/* =========================
DB CONNECT
========================= */
const mongoURI = "mongodb+srv://meena:uniokesugcoms@cluster0.i2uggah.mongodb.net/verifydb?retryWrites=true&w=majority";

mongoose.connect(mongoURI, {
    serverSelectionTimeoutMS: 8000
}).catch((err) => {
    console.log("❌ DB Initial Connection Blocked:", err.message);
});

mongoose.connection.on('connected', () => {
    console.log("💾 MongoDB Connected Successfully");
});

/* =========================
SCHEMA
========================= */
const userSchema = new mongoose.Schema({
    tgId:        { type: String, required: true },
    botUsername: { type: String, required: true },
    deviceKey:   { type: String, required: true },
    ip:          String,
    status: {
        type: String,
        enum: ["pass", "fail"],
        default: "pass"
    },
    reason:    String,
    createdAt: { type: Date, default: Date.now }
});

userSchema.index({ tgId: 1, botUsername: 1 }, { unique: true });

const User = mongoose.models.VerifiedUser || mongoose.model('VerifiedUser', userSchema);

/* =========================
TELEGRAM ALERT
========================= */
function sendAlert(token, chatId, text) {
    return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text: text,
            parse_mode: 'HTML'
        })
    }).catch((err) => { console.log("Telegram Dispatch Error:", err.message); });
}

/* =========================
FIRE WEBHOOK TO TBC
========================= */
async function fireWebhook(webhookUrl, payload) {
    if (!webhookUrl) return;
    try {
        await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        console.log("Webhook Fire Error:", err.message);
    }
}

/* =========================
DB SAVER
========================= */
function saveUserLog(tgId, botUsername, deviceKey, ip, status, reason) {
    return User.updateOne(
        { tgId: tgId, botUsername: botUsername },
        {
            $set: {
                tgId,
                botUsername,
                deviceKey,
                ip,
                status,
                reason,
                createdAt: new Date()
            }
        },
        { upsert: true }
    ).catch((err) => {
        console.log("Background DB Sync Error:", err.message);
    });
}

/* =========================
VPN CHECK
========================= */
async function triggerVpnCheck(ip, bottoken, tg_id, webhookUrl) {
    try {
        if (!ip || ip === "0.0.0.0" || ip === "UNKNOWN") return;
        const res  = await fetch(`http://ip-api.com/json/${ip}?fields=proxy,hosting`);
        const data = await res.json();
        if (data.proxy || data.hosting) {
            await sendAlert(
                bottoken,
                tg_id,
                `⚠️ <b>VPN DETECTED</b>\nProxy/VPN found for ID: <code>${tg_id}</code>`
            );
            // Fire webhook for VPN too
            await fireWebhook(webhookUrl, {
                status: "fail",
                message: "VPN Detected"
            });
        }
    } catch {}
}

/* =========================
MAIN VERIFY API
========================= */
app.get('/api', async (req, res) => {
    try {
        const { botusername, bottoken, tg_id, browser_id, webhook } = req.query;

        if (!botusername || !bottoken || !tg_id || !browser_id) {
            return res.json({ status: "fail", message: "Missing Parameters" });
        }

        let ip = "0.0.0.0";
        try {
            ip = req.clientIp || req.headers['x-forwarded-for'] || req.socket.remoteAddress || "0.0.0.0";
            if (ip.includes(',')) ip = ip.split(',')[0].trim();
        } catch {}

        const deviceKey = `${browser_id}`;

        let user = null;
        try {
            user = await User.findOne({ tgId: tg_id, botUsername: botusername });
        } catch (dbErr) {
            console.log("DB lookup skipped:", dbErr.message);
        }

        // CASE 1: Permanently Blocked
        if (user && user.status === "fail") {
            await fireWebhook(webhook, { status: "fail", message: "Permanently Blocked" });
            return res.json({ status: "fail", message: "Permanently Blocked" });
        }

        // CASE 2: Already Verified
        if (user && user.status === "pass") {
            await fireWebhook(webhook, { status: "pass", message: "Already Verified" });
            return res.json({ status: "pass", message: "Already Verified" });
        }

        // CASE 3: Same Device Different User
        let conflict = null;
        try {
            conflict = await User.findOne({
                deviceKey:   deviceKey,
                botUsername: botusername,
                tgId:        { $ne: tg_id },
                status:      "pass"
            });
        } catch (err) {
            console.log("Conflict tracking error:", err.message);
        }

        if (conflict) {
            await saveUserLog(tg_id, botusername, deviceKey, ip, "fail", "Device already used");
            await fireWebhook(webhook, { status: "fail", message: "Device already used" });
            return res.json({ status: "fail", message: "Device already used" });
        }

        // CASE 4: Fresh Verified
        await saveUserLog(tg_id, botusername, deviceKey, ip, "pass", "");
        await fireWebhook(webhook, { status: "pass", message: "Verified Successfully" });

        // Silent VPN check in background
        triggerVpnCheck(ip, bottoken, tg_id, webhook);

        return res.json({ status: "pass", message: "Verified Successfully" });

    } catch (err) {
        console.log("CRASH:", err.message);
        return res.json({ status: "fail", message: "System busy. Try again." });
    }
});

/* =========================
CHECK STATUS API
========================= */
app.get('/api/check', async (req, res) => {
    try {
        const { botusername, tg_id } = req.query;

        if (!botusername || !tg_id) {
            return res.json({ status: "pending" });
        }

        let user = null;
        try {
            user = await User.findOne({
                tgId:        tg_id,
                botUsername: botusername
            });
        } catch (err) {
            console.log("Check DB Error:", err.message);
        }

        if (!user) {
            return res.json({ status: "pending" });
        }

        return res.json({ status: user.status });

    } catch (err) {
        console.log("Check Error:", err.message);
        return res.json({ status: "pending" });
    }
});

/* =========================
EXPORT
========================= */
module.exports = app;
