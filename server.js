var WebSocketServer = require('ws').Server,
    http = require('http'),
    express = require('express'),
    app = express(),
    sync = require('synchronize'),
    bitcoin = require('bitcoin'),
    path = require('path'),
    Firebase = require('firebase'),
    fbDataRef = new Firebase(process.env.FIREBASEURL);

var server = http.createServer(app);
server.listen(process.env.PORT || process.env.OPENSHIFT_NODEJS_PORT || 5000, process.env.OPENSHIFT_NODEJS_IP || process.env.IP || "0.0.0.0");

var wss = new WebSocketServer({
    server: server,
    clientTracking: true
});

// litecoind client
var client = new bitcoin.Client({
    host: process.env.LTCHOST,
    port: process.env.LTCPORT,
    user: process.env.LTCUSER,
    pass: process.env.LTCPASS
});

// Sync Functions
sync(client, 'getBlockCount');
sync(client, 'getBlockHash');
sync(client, 'getBlock');
sync(client, 'getRawTransaction');

var lastBlockHash,
    currentTransactions,
    executionInterval = 100,
    isRunning = false,
    isReady = false,
    isDebug = true;

/*
Get the latest block and transaction from the firebase account,
so if the service is restarted the web socket does not send duplicate
*/
fbDataRef.on('value', function(data) {
    if (data.val() !== null) {
        if (data.val().latestTransactions !== undefined) {
            try {
                currentTransactions = JSON.parse(data.val().latestTransactions);
            }
            catch (e) {
                currentTransactions = [];
            }
        }

        if (data.val().latestBlock !== undefined) {
            lastBlockHash = data.val().latestBlock;
        }
    }

    isReady = true;

    fbDataRef.off('value');
});

var intervalId = setInterval(function() {
    // Wait for 
    if (!isReady) return;

    if (isRunning) return;

    isRunning = true;

    getTx();

}, executionInterval);

var transactionSubscribers = [],
    blockSubscribers = [],
    clientId = 0;

wss.on('connection', function(ws) {
    var thisId = ++clientId;
    ws.on('message', function(message, flags) {

        try {
            var parsedMessage = JSON.parse(message);

            if (parsedMessage['op'] === 'tx_sub') {

                transactionSubscribers.push(ws);

                if (isDebug) console.log('Added new subscriber to transactions');

            }
            else if (parsedMessage['op'] === 'blocks_sub') {

                blockSubscribers.push(ws);

                if (isDebug) console.log('Added new subscriber to blocks');

            }
        }
        catch (e) {

        }
    });

    ws.on('close', function() {
        var indexTx = transactionSubscribers.indexOf(ws),
            indexBlocks = blockSubscribers.indexOf(ws);

        if (indexTx > -1) {
            transactionSubscribers.splice(indexTx, 1);

            if (isDebug) console.log('remove subscriber from transactions');
        }

        if (indexBlocks > -1) {
            blockSubscribers.splice(indexTx, 1);

            if (isDebug) console.log('remove subscriber from blocks');
        }

    });
});

function getTx() {

    sync.fiber(function() {
        var blockIndex = client.getBlockCount(),
            blockHash = client.getBlockHash(blockIndex),
            block = client.getBlock(blockHash),
            isOldBlock = (blockHash === lastBlockHash)

            block.nTx = block.tx.length;

        if (!isOldBlock) {

            // Save latest block on firebase
            fbDataRef.child('latestBlock').set(blockHash);

            var b = {
                op: "block",
                x: block
            };

            if (isDebug) console.log('Found New Block');

            currentTransactions = [];

            if (isDebug) console.log(b);

            for (var counter = 0; counter < blockSubscribers.length; counter++) {
                try {

                    blockSubscribers[counter].send(JSON.stringify(b));

                }
                catch (e) {

                    if (isDebug) console.log(e);

                }
            }

        }

        broadCastBlockData(block);

        lastBlockHash = blockHash;

        isRunning = false;


    });
}

function broadCastBlockData(block) {

    // if this block does not have any transactions we dont broadcast it
    if (block.tx.length <= 0) return;

    block.tx.forEach(function(txId) {
        // Check it is a new transaction
        if (currentTransactions.indexOf(txId) == -1) {
            currentTransactions.push(txId);

            // Update list of transactions on firebase
            fbDataRef.child('latestTransactions').set(JSON.stringify(currentTransactions));

            var txData = client.getRawTransaction(txId, 1),
                outs = [],
                ins = [];

            if (txData.vout.length > 0) {
                txData.vout.forEach(function(i) {
                    outs.push({
                        value: i.value,
                        addr: i.scriptPubKey.addresses === undefined ? '' : i.scriptPubKey.addresses.length > 0 ? i.scriptPubKey.addresses[0] : '',
                        type: i.scriptPubKey.type
                    });
                });
            }

            if (txData.vin.length > 0) {

                txData.vin.forEach(function(i) {
                    // If no txid then it means it is a block
                    if (i.txid === undefined || i.txid === '') return;

                    var txInfo = client.getRawTransaction(i.txid, 1);

                    txInfo.vout.forEach(function(o) {
                        if (i.vout === o.n) {
                            ins.push({
                                prev_out: {
                                    value: o.value,
                                    addr: o.scriptPubKey.addresses === undefined ? '' : o.scriptPubKey.addresses.length > 0 ? o.scriptPubKey.addresses[0] : '',
                                    type: o.scriptPubKey.type
                                }
                            });
                        }
                    });
                });
            }

            var output = {
                op: 'utx',
                block_hash: txData.blockhash,
                x: {
                    hash: txData.txid,
                    ver: txData.version,
                    time: txData.time,
                    lock_time: txData.locktime,
                    vin_sz: txData.vin.length,
                    vout_sz: txData.vout.length,
                    inputs: ins,
                    out: outs,
                }
            };

            var jsonOutput = JSON.stringify(output);

            if (isDebug) console.log('Broadcasting [Tx %s ] | [Block %s]', txId, txData.blockhash);

            for (var counter = 0; counter < transactionSubscribers.length; counter++) {
                try {

                    transactionSubscribers[counter].send(jsonOutput);

                }
                catch (e) {

                    if (isDebug) console.log(e);

                }
            }
        }
    });
}

/**
 * Express 
 */
// global controller
app.get('/*', function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    next();
});

// uptime monitor checks for this reply
app.get('/areyoualive', function(req, res) {
    res.send('yes');
});

// REST API
app.get('/:op/:id?', function(req, res, next) {
    sync.fiber(function() {

        res.set('Content-Type', 'application/json');

        try {

            //Blocks
            if (req.params.op === 'block') {

                var hash = req.params.id;
                
                // if the parameter is an integer then it is a block index
                if(typeof hash === 'number' && hash % 1 === 0){
                    
                    hash = client.getBlockHash(hash);
                    
                }
                
                var block = client.getBlock(hash);

                res.send(JSON.stringify(block));

            }
            else if (req.params.op === 'tx') {

                var id = req.params.id;

                var tx = client.getRawTransaction(id, 1);

                res.send(JSON.stringify(tx));
            }
            else if (req.params.op === 'latestblock') {

                var blockIndex = client.getBlockCount();

                var blockHash = client.getBlockHash(blockIndex);

                var block = client.getBlock(blockHash);

                res.send(JSON.stringify(block));

            }
            else if (req.params.op === 'latesttx') {

                var blockIndex = client.getBlockCount();

                var blockHash = client.getBlockHash(blockIndex);

                var block = client.getBlock(blockHash);

                var tx = client.getRawTransaction(block.tx[block.tx.length - 1], 1);

                res.send(JSON.stringify(tx));

            }
            else {

                res.send(JSON.stringify({
                    error: "Unknown Command"
                }));

            }
        }
        catch (e) {

            res.send(JSON.stringify({
                error: "Invalid Parameters"
            }));

        }
    });
});

// Default Route
app.get('*', function(req, res) {
    res.send(JSON.stringify({
        error: "Unknown Command"
    }));
});