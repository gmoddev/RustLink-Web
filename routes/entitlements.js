const express = require('express');
const Router = express.Router();

const { pool } = require('../db');
const AuthMiddleware = require('../middleware/auth');

Router.post('/update-entitlements', AuthMiddleware, async (req, res) => {
    const { discordId, entitlements } = req.body;

    if (!discordId || !entitlements || typeof entitlements !== 'object') {
        return res.status(400).json({
            success: false,
            error: 'discordId and entitlements object are required'
        });
    }

    const Client = await pool.connect();

    try {
        await Client.query('BEGIN');

        const LinkResult = await Client.query(
            `SELECT SteamId FROM UserLinks WHERE DiscordId = $1 LIMIT 1`,
            [discordId]
        );

        if (LinkResult.rows.length === 0) {
            await Client.query('ROLLBACK');
            return res.json({
                success: false,
                error: 'No linked Steam account found'
            });
        }

        const SteamId = LinkResult.rows[0].steamid;

        for (const [Key, Value] of Object.entries(entitlements)) {
            await Client.query(
                `
                INSERT INTO Entitlements (SteamId, Key, Value, LastUpdated)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (SteamId, Key)
                DO UPDATE SET
                    Value = EXCLUDED.Value,
                    LastUpdated = NOW()
                `,
                [SteamId, Key, !!Value]
            );
        }

        await Client.query('COMMIT');

        return res.json({ success: true });
    }
    catch (Error) {
        await Client.query('ROLLBACK');
        console.error('update-entitlements error:', Error);

        return res.status(500).json({
            success: false,
            error: 'Database error'
        });
    }
    finally {
        Client.release();
    }
});

Router.post('/get-entitlements', AuthMiddleware, async (req, res) => {
    const { steamId } = req.body;

    if (!steamId) {
        return res.status(400).json({
            success: false,
            error: 'steamId is required'
        });
    }

    try {
        const Result = await pool.query(
            `
            SELECT Key, Value
            FROM Entitlements
            WHERE SteamId = $1
            `,
            [steamId]
        );

        const Entitlements = {};

        for (const Row of Result.rows) {
            Entitlements[Row.key] = Row.value;
        }

        return res.json({
            success: true,
            entitlements: Entitlements
        });
    }
    catch (Error) {
        console.error('get-entitlements error:', Error);

        return res.status(500).json({
            success: false,
            error: 'Database error'
        });
    }
});

// -------------------------
// UPDATE ENTITLEMENTS
// -------------------------
Router.post('/update-entitlements', AuthMiddleware, async (req, res) => {
    const { steamId } = req.body;

    if (!steamId) {
        return res.status(400).json({
            success: false,
            error: 'steamId is required'
        });
    }

    try {
        // Check linked
        const LinkResult = await pool.query(
            `SELECT DiscordId FROM UserLinks WHERE SteamId = $1 LIMIT 1`,
            [steamId]
        );

        if (LinkResult.rows.length === 0) {
            return res.json({
                success: false,
                error: 'Not linked'
            });
        }

        // Get entitlements
        const EntitlementResult = await pool.query(
            `SELECT Key, Value FROM Entitlements WHERE SteamId = $1`,
            [steamId]
        );

        const enabled = [];

        for (const row of EntitlementResult.rows) {
            if (row.value === true) {
                enabled.push(row.key.toLowerCase());
            }
        }

        return res.json({
            success: true,
            entitlements: enabled
        });
    }
    catch (Error) {
        console.error('update-entitlements error:', Error);

        return res.status(500).json({
            success: false,
            error: 'Database error'
        });
    }
});

module.exports = Router;