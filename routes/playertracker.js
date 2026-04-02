const express = require('express');
const Router = express.Router();

const { pool } = require('../db');
const AuthMiddleware = require('../middleware/auth');

// -------------------------
// INIT TABLES
// -------------------------
async function InitTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Sessions (
            Id SERIAL PRIMARY KEY,
            UserId INTEGER NOT NULL,
            Platform TEXT NOT NULL,
            JoinTime BIGINT NOT NULL,
            LeaveTime BIGINT
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON Sessions(UserId, Platform);
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_sessions_time
        ON Sessions(JoinTime);
    `);
}

InitTables();

// -------------------------
// HELPERS
// -------------------------
async function GetUserId(platform, platformId) {
    const result = await pool.query(
        `SELECT UserId FROM UserAccounts WHERE Platform = $1 AND PlatformId = $2`,
        [platform, platformId]
    );

    if (result.rows.length === 0) return null;
    return result.rows[0].userid;
}

function NormalizeArray(input) {
    if (!Array.isArray(input)) return [input];
    return input;
}

async function GetOpenSession(client, userId, platform) {
    const result = await client.query(`
        SELECT * FROM Sessions
        WHERE UserId = $1 AND Platform = $2 AND LeaveTime IS NULL
        ORDER BY JoinTime DESC
        LIMIT 1
    `, [userId, platform]);

    return result.rows[0] || null;
}

// -------------------------
// /join (AUTO CLOSE + START)
// -------------------------
Router.post('/join', AuthMiddleware, async (req, res) => {
    const entries = NormalizeArray(req.body);

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const results = [];

        for (const e of entries) {
            const userId = await GetUserId(e.Platform, e.ID);
            if (!userId) continue;

            const now = Date.now();

            const existing = await GetOpenSession(client, userId, e.Platform);

            if (existing) {
                await client.query(`
                    UPDATE Sessions
                    SET LeaveTime = $1
                    WHERE Id = $2
                `, [now, existing.id]);
            }

            await client.query(`
                INSERT INTO Sessions (UserId, Platform, JoinTime)
                VALUES ($1, $2, $3)
            `, [userId, e.Platform, now]);

            results.push({
                ID: e.ID,
                Platform: e.Platform,
                action: existing ? 'closed_previous_started_new' : 'started'
            });
        }

        await client.query('COMMIT');
        return res.json({ success: true, data: results });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// -------------------------
// /leave (AUTO CLOSE)
// -------------------------
Router.post('/leave', AuthMiddleware, async (req, res) => {
    const entries = NormalizeArray(req.body);

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const results = [];

        for (const e of entries) {
            const userId = await GetUserId(e.Platform, e.ID);
            if (!userId) continue;

            const now = Date.now();

            const existing = await GetOpenSession(client, userId, e.Platform);

            if (existing) {
                await client.query(`
                    UPDATE Sessions
                    SET LeaveTime = $1
                    WHERE Id = $2
                `, [now, existing.id]);

                results.push({ ID: e.ID, Platform: e.Platform, action: 'closed' });
            } else {
                results.push({ ID: e.ID, Platform: e.Platform, action: 'no_active_session' });
            }
        }

        await client.query('COMMIT');
        return res.json({ success: true, data: results });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// -------------------------
// /addsession
// -------------------------
Router.post('/addsession', AuthMiddleware, async (req, res) => {
    const entries = NormalizeArray(req.body);

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const results = [];

        for (const e of entries) {
            const userId = await GetUserId(e.Platform, e.ID);
            if (!userId) continue;

            await client.query(`
                INSERT INTO Sessions (UserId, Platform, JoinTime, LeaveTime)
                VALUES ($1, $2, $3, $4)
            `, [userId, e.Platform, e.JoinTime, e.LeaveTime]);

            results.push({
                ID: e.ID,
                Platform: e.Platform,
                Duration: e.LeaveTime - e.JoinTime
            });
        }

        await client.query('COMMIT');
        return res.json({ success: true, data: results });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// -------------------------
// /getsessions (ARRAY + PAGINATION)
// -------------------------
Router.post('/getsessions', AuthMiddleware, async (req, res) => {
    const { page = 1, limit = 25 } = req.query;
    const offset = (page - 1) * limit;

    const entries = NormalizeArray(req.body);

    try {
        const results = [];

        for (const e of entries) {
            const userId = await GetUserId(e.Platform, e.ID);
            if (!userId) continue;

            const rows = await pool.query(`
                SELECT *,
                (CASE WHEN LeaveTime IS NOT NULL THEN LeaveTime - JoinTime ELSE NULL END) as Duration
                FROM Sessions
                WHERE UserId = $1 AND Platform = $2
                ORDER BY JoinTime DESC
                LIMIT $3 OFFSET $4
            `, [userId, e.Platform, limit, offset]);

            const total = await pool.query(`
                SELECT COUNT(*) FROM Sessions
                WHERE UserId = $1 AND Platform = $2
            `, [userId, e.Platform]);

            results.push({
                ID: e.ID,
                Platform: e.Platform,
                page: Number(page),
                total: Number(total.rows[0].count),
                sessions: rows.rows
            });
        }

        return res.json({ success: true, data: results });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false });
    }
});

// -------------------------
// /getallsessions
// -------------------------
Router.get('/getallsessions', AuthMiddleware, async (req, res) => {
    let { from, to, page = 1, limit = 50 } = req.query;

    const now = Date.now();
    from = from ? Number(from) : new Date().setHours(0,0,0,0);
    to = to ? Number(to) : now;

    const offset = (page - 1) * limit;

    try {
        const rows = await pool.query(`
            SELECT *,
            (CASE WHEN LeaveTime IS NOT NULL THEN LeaveTime - JoinTime ELSE NULL END) as Duration
            FROM Sessions
            WHERE JoinTime >= $1 AND JoinTime <= $2
            ORDER BY JoinTime DESC
            LIMIT $3 OFFSET $4
        `, [from, to, limit, offset]);

        const total = await pool.query(`
            SELECT COUNT(*) FROM Sessions
            WHERE JoinTime >= $1 AND JoinTime <= $2
        `, [from, to]);

        return res.json({
            success: true,
            page: Number(page),
            total: Number(total.rows[0].count),
            data: rows.rows
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false });
    }
});

module.exports = Router;