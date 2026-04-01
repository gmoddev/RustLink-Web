const express = require('express');
const cors = require('cors');
require('dotenv').config();

const InitDb = require('./initDb');

const App = express();

App.use(cors());
App.use(express.json());

App.get('/', (req, res) => {
    res.json({
        success: true,
        name: 'AccountLink API',
        status: 'online'
    });
});

App.use('/', require('./routes/link'));
App.use('/', require('./routes/entitlements'));
App.use('/callsign',require('./routes/callsigns'))
App.use('/server', require('./routes/rustreport'));
async function StartServer() {
    try {
        await InitDb();

        App.listen(process.env.PORT, () => {
            console.log(`AccountLink API running on port ${process.env.PORT}`);
        });
    }
    catch (Error) {
        console.error('Failed to start server:', Error);
        process.exit(1);
    }
}

StartServer();