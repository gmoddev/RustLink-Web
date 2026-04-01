const express = require('express');
const Router = express.Router();

const { pool } = require('../db');
const AuthMiddleware = require('../middleware/auth');

// -------------------------
// INIT TABLES (AUTO CREATE)
// -------------------------
async function InitTables() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Teams (
            Id SERIAL PRIMARY KEY,
            Name TEXT UNIQUE NOT NULL,
            CallsignBase TEXT NOT NULL
        );
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS Callsigns (
            Id SERIAL PRIMARY KEY,
            TeamId INTEGER REFERENCES Teams(Id) ON DELETE CASCADE,
            Number INTEGER NOT NULL,
            UserId INTEGER UNIQUE,
            UNIQUE (TeamId, Number)
        );
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_callsigns_user ON Callsigns(UserId);
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

async function GetCallsignString(userId) {
    const result = await pool.query(`
        SELECT T.CallsignBase, C.Number
        FROM Callsigns C
        JOIN Teams T ON T.Id = C.TeamId
        WHERE C.UserId = $1
    `, [userId]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return `${row.callsignbase}-${row.number}`;
}

async function GetOrCreateTeam(client, teamName, callsignBase = null) {
    let team = await client.query(
        `SELECT * FROM Teams WHERE Name = $1`,
        [teamName]
    );

    if (team.rows.length > 0) return team.rows[0];

    if (!callsignBase) return null;

    const created = await client.query(
        `INSERT INTO Teams (Name, CallsignBase)
         VALUES ($1, $2)
         RETURNING *`,
        [teamName, callsignBase]
    );

    return created.rows[0];
}

async function GetNextCallsignNumber(client, teamId) {
    const result = await client.query(`
        SELECT COALESCE(MIN(t1.Number + 1), 1) AS next
        FROM Callsigns t1
        WHERE t1.TeamId = $1
          AND NOT EXISTS (
            SELECT 1 FROM Callsigns t2
            WHERE t2.TeamId = $1 AND t2.Number = t1.Number + 1
          )
    `, [teamId]);

    return result.rows[0].next || 1;
}

// -------------------------
// GET CALLSIGN
// -------------------------
Router.post('/get', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;

    if (!platform || !platformId) {
        return res.status(400).json({ success: false });
    }

    const userId = await GetUserId(platform, platformId);
    if (!userId) return res.json({ success: false });

    const callsign = await GetCallsignString(userId);

    return res.json({
        success: true,
        userId,
        callsign
    });
});

// -------------------------
// AUTO ASSIGN (AutoCheck)
// -------------------------
Router.post('/auto', AuthMiddleware, async (req, res) => {
    const { platform, platformId, teamName, callsignBase } = req.body;

    if (!platform || !platformId || !teamName) {
        return res.status(400).json({ success: false });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userId = await GetUserId(platform, platformId);
        if (!userId) throw new Error('User not found');

        // Already has callsign?
        const existing = await client.query(
            `SELECT * FROM Callsigns WHERE UserId = $1`,
            [userId]
        );

        if (existing.rows.length > 0) {
            await client.query('COMMIT');
            return res.json({
                success: true,
                callsign: await GetCallsignString(userId),
                existed: true
            });
        }

        // Get or create team
        const team = await GetOrCreateTeam(client, teamName, callsignBase);
        if (!team) throw new Error('Team not found and no base provided');

        const number = await GetNextCallsignNumber(client, team.id);

        await client.query(`
            INSERT INTO Callsigns (TeamId, Number, UserId)
            VALUES ($1, $2, $3)
        `, [team.id, number, userId]);

        await client.query('COMMIT');

        return res.json({
            success: true,
            callsign: await GetCallsignString(userId),
            existed: false
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// -------------------------
// SET CALLSIGN
// -------------------------
Router.post('/set', AuthMiddleware, async (req, res) => {
    const { platform, platformId, teamName, callsignBase, number } = req.body;

    if (!platform || !platformId || !teamName || !number) {
        return res.status(400).json({ success: false });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userId = await GetUserId(platform, platformId);
        if (!userId) throw new Error('User not found');

        const team = await GetOrCreateTeam(client, teamName, callsignBase);
        if (!team) throw new Error('Team not found');

        await client.query(`
            INSERT INTO Callsigns (TeamId, Number, UserId)
            VALUES ($1, $2, $3)
            ON CONFLICT (UserId)
            DO UPDATE SET TeamId = $1, Number = $2
        `, [team.id, number, userId]);

        await client.query('COMMIT');

        return res.json({
            success: true,
            callsign: await GetCallsignString(userId)
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// -------------------------
// RESET CALLSIGN
// -------------------------
Router.post('/reset', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;

    if (!platform || !platformId) {
        return res.status(400).json({ success: false });
    }

    const userId = await GetUserId(platform, platformId);
    if (!userId) return res.json({ success: false });

    await pool.query(
        `DELETE FROM Callsigns WHERE UserId = $1`,
        [userId]
    );

    return res.json({ success: true });
});

// -------------------------
// REMOVE USER
// -------------------------
Router.post('/remove-user', AuthMiddleware, async (req, res) => {
    const { platform, platformId } = req.body;

    if (!platform || !platformId) {
        return res.status(400).json({ success: false });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const userId = await GetUserId(platform, platformId);
        if (!userId) throw new Error('User not found');

        await client.query(
            `DELETE FROM Callsigns WHERE UserId = $1`,
            [userId]
        );

        await client.query(
            `DELETE FROM UserAccounts WHERE UserId = $1`,
            [userId]
        );

        await client.query(
            `DELETE FROM Users WHERE Id = $1`,
            [userId]
        );

        await client.query('COMMIT');

        return res.json({ success: true });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        return res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

// Create Team
Router.post('/create-team', AuthMiddleware, async (req, res) => {
    const { name, callsignBase } = req.body;

    if (!name || !callsignBase) {
        return res.status(400).json({ success: false });
    }

    try {
        await pool.query(
            `INSERT INTO Teams (Name, CallsignBase)
             VALUES ($1, $2)
             ON CONFLICT (Name) DO NOTHING`,
            [name, callsignBase]
        );

        return res.json({ success: true });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false });
    }
});

module.exports = Router;