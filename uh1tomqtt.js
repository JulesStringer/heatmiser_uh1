// Script to interact via uh1 rs485 device,
// publish updates from the UH1 to mqtt
// subscribe to updates to thermostats from mqtt
//
const SerialPort = require('serialport').SerialPort;
const mqtt = require('mqtt');
const dcblib = require('./dcblib.js');
const {RS485BusManager} = require('./dcblib.js');
const fs = require('fs');
const baud_rate = 4800;

//const uh1txport = 'usb-WCH.CN_USB_Quad_Serial_BC6283ABCD-if00'; 
//const uh1txport = 'usb-WCH.CN_USB_Quad_Serial_BC6283ABCD-if02'; 
const uh1txport = 'usb-1a86_USB_Serial-if00-port0';
const uh1rxport = uh1txport;
const masterid = 130;
const slaveIds = [1,2,3,4,5,6,7,8,9];
const mqtt_broker_file = '/home/jules/.credentials/mqtt/mqtt_broker.json';
// find a serial port
// the UH1 RS485 bus is connected to the first position on a waveshare 4XRS485 to USB box,
// which is plugged in to a USB port on the raspberry Pi
//
async function findAvailableSerialPort(pnpId, baud_rate) {
    const ports = await SerialPort.list();
    
    // 1. Filter ports by the non-unique pnpId
    const candidatePorts = ports.filter(port => port.pnpId && port.pnpId.includes(pnpId));

    console.log(`Found ${candidatePorts.length} candidate ports with pnpId ${pnpId}.`);

    for (const portInfo of candidatePorts) {
        console.log(`Testing Port: ${portInfo.path}`);
        
        // 2. Attempt to create and open the port
        const sport = new SerialPort({
            path: portInfo.path, 
            baudRate: baud_rate, // Use the specific baud rate for the device you are looking for (e.g., 9600 for Modbus)
            dataBits: 8,
            parity: 'none',
            stopBits: 1,
            rtscts: true,
            autoOpen: false 
        });

        let portIsAvailable = false;
        
        try {
            // Attempt to open the port. If another process has it locked, this will throw an error.
            await new Promise((resolve, reject) => {
                sport.open((err) => {
                    if (err) {
                        console.log(`-> Port ${portInfo.path} is busy or unavailable. Error: ${err.message}`);
                        reject(err);
                    } else {
                        console.log(`-> Port ${portInfo.path} successfully opened (Available).`);
                        portIsAvailable = true;
                        resolve();
                    }
                });
            });
            
            // 3. If the open succeeded, return the port and exit the function.
            if (portIsAvailable) {
                return sport;
            }
            
        } catch (e) {
            // Error means the port is busy or has other issues. Loop continues to the next port.
        }
        
        // IMPORTANT: If we failed to open (busy) or opened and we need to move on (shouldn't happen here), 
        // ensure the port is closed before the next iteration.
        if (sport.isOpen) {
            sport.close(() => {});
        }
    }
    
    // 4. If the loop completes without finding an available port
    return null;
}
async function openPort(pnpId){
    const sport = await findAvailableSerialPort(pnpId, baud_rate);
    
    if (!sport) {
        throw new Error(`Could not find an available serial port with pnpId ${pnpId}`);
    }

    console.log(`Modbus using path: ${sport.path}`);

    // Assuming the port is already open from findAvailableSerialPort, 
    // you would only need to add listeners and handle initialization.
    // However, if the logic above closes the port on failure, 
    // you need to safely re-open it here OR modify the discovery function
    // to return the OPEN port.
    
    // --- Assuming findAvailableSerialPort returns an OPEN port ---
    
    // Error listener for port errors
    sport.on('error', (err) => {
        console.log(`Serial Port Error on ${sport.path}:`, err.message);
    });
    
    return sport;
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function loadJSON(filepath){
    let data = await fs.promises.readFile(filepath);
    return JSON.parse(data);
}
async function connect_mqtt(){
    const mqtt_spec = await loadJSON(mqtt_broker_file);
    // Create MQTT client
    const mqtt_client = mqtt.connect(mqtt_spec.mqtt_broker);
    return new Promise((resolve, reject) => {
        mqtt_client.on('connect', () => {
            console.log("Connected to MQTT broker " + mqtt_spec.mqtt_broker);
            resolve(mqtt_client);
        });
        mqtt_client.on('error', (err) =>{
            reject(err);
        })
    });
}
let txport = null;
let rxport = null;
let thermostats = [];
async function initialise(log = false){
    txport = await openPort(uh1txport);
    //rxport = await openPort(uh1rxport);
    if ( uh1rxport === uh1txport ){
        rxport = txport;
    } else {
        rxport = await openPort(uh1rxport);
    }
    let rs485bus_manager = new RS485BusManager(rxport, txport);
    console.log('rs485bus_manager created');
    for(const id of slaveIds){
        const thermostat = new dcblib.Thermostat(id, masterid, rs485bus_manager, log);
        thermostats.push(thermostat);
    }
    console.log('Thermostats created');
}

async function readThermostats(){
    for(const thermostat of thermostats){
        try {
            await thermostat.read();
        } catch(err){
            console.log(err.toString());
        }
    }
}
async function checktime(thermostat){
    console.log(`checktime ID: ${thermostat.thermostatID}`)
    if ( thermostat.status ){
        let d = new Date();
        let day = d.getDay();
        day = day === 0 ? 7 : day;
        let hour = d.getHours();
        let minute = d.getMinutes();
        let second = d.getSeconds();
        let timenow = minutetime(day, hour, minute);
        let dt = thermostat.status.dayandtime_split;
        let thermotime = minutetime(dt.day, dt.hour, dt.minute);
        console.log(`thermotime ${thermotime} timenow ${timenow}`);
        let tdiff = thermotime > timenow ? (thermotime - timenow) : (timenow - thermotime);
        if ( tdiff > 1 ){
            console.log(`timenow: ${timenow} thermotime: ${thermotime} tdiff: ${tdiff}`);
            let time_array = [day, hour, minute, second];
            let data = Buffer.from(time_array);
            console.log('Need to update date/time');
            await thermostat.writeSettings(dcblib.dcb_constants.HM_ADDRESS_DAY_AND_TIME, data);
            console.log('updated time');
            delay(1000);
        }
    }
}
async function publishThermostats(){
    const mqtt_client = await connect_mqtt();
    await initialise(false);
    await readThermostats();
    // handle any updates
    mqtt_client.subscribe('heatmiser_update/#');
    mqtt_client.on('message',async function(topic, message){
        if ( topic.startsWith('heatmiser_update')){
            let data = JSON.parse(message.toString());
            let parts = topic.split('/');
            let id = parseInt(parts[1]);
            console.log(topic + ' : ' + JSON.stringify(data));
            for(let t of thermostats){
                if ( t.thermostatID == id){
                    t.trace = true;
                    await t.update(data);
                    delay(1000);
                    await t.read();
                    t.trace = false;
                }
            }
        }
    });
    // config and schedule are published at start and when changed
    for(const t of thermostats){
        if ( t.config ){
            let topic = `heatmiser/${t.thermostatID}/config`;
            mqtt_client.publish(topic, JSON.stringify(t.config), {qos: 1, retain:true});
            console.log(topic + ' : ' + JSON.stringify(t.config, null, 2));
        }
        if ( t.schedule ){
            let topic = `heatmiser/${t.thermostatID}/schedule`;
            mqtt_client.publish(topic, JSON.stringify(t.schedule), {qos: 1, retain:true});
            console.log(topic + ' : ' + JSON.stringify(t.schedule, null, 2));
        }
    }
    let minutes = 15;
    let status_summaries = {};
    // status is published every minute
    while(1){
        await readThermostats();
        let changes = [];
        for(const t of thermostats){
            if ( t.status ){
                try {
                    await t.read();
                    let topic = `heatmiser/${t.thermostatID}/status`;
                    mqtt_client.publish(topic, JSON.stringify(t.status), { qos:1, retain:true});
                    console.log(topic);
                } catch(err){
                    let topic = `heatmiser/${t.thermostatID}/status`;
                    let msg = {
                        error: err.toString()
                    }
                    console.log(err.toString());
                    mqtt_client.publish(topic, JSON.stringify(msg), { qos:1, retain:true});
                }
            }
            await checktime(t);
            // compare with previous for this thermostat.
            if ( t.status_summary ){
                if ( minutes === 15 ){
                    changes.push(t.status_summary);
                } else if ( status_summaries[t.thermostatID]){
                    if ( t.compare_status_summary(status_summaries[t.thermostatID])){
                        changes.push(t.status_summary);
                    }
                }
                status_summaries[t.thermostatID] = t.status_summary;
            }
        }
        if ( changes.length > 0 ){
            const topic = `heatmiser/status_changes`;
            try{

                mqtt_client.publish(topic, JSON.stringify(changes), {qos:1});
                console.log(topic);
                console.log(JSON.stringify(changes,null,2));
            } catch(err){
                let msg = {
                    error: err.toString()
                }
                console.log(err.toString());
                mqtt_client.publish(topic, JSON.stringify(msg), { qos:1});
            }
        }
        minutes ++;
        if ( minutes > 15 ){
            minutes = 0;
        }
        console.log('minutes: ' + minutes);
        // write any queued changes
        await delay(60000); // probably make this a minute or even longer in the end.
        // cycle minutes every 15 minutes
    }
}
async function report(){
    await initialise();
    console.log('Initialised');
    await readThermostats();
    console.log('Read thermostats');
    for(const t of thermostats){
        let config = t.config;
        console.log(JSON.stringify(config));
        console.log('================= config ========================');
        for(const key in config){
            if ( key === 'sensor'){
                console.log(key + ' : ' + JSON.stringify(config.sensor));
            } else {
                console.log(key + ' : ' + config[key]);
            }
        }
        console.log('================= schedule ========================');
        let schedule = t.schedule;
        console.log(JSON.stringify(schedule));
        for(const key in schedule){
            let period = schedule[key];
            console.log('----- ' + key);
            for(const p of period){
                console.log(JSON.stringify(p));
            }
        }
        console.log('================= status ============================');
        let status = t.status;
        console.log(JSON.stringify(status));
        for(const key in status){
            if ( key === 'heating'){
                console.log(key + ' : ' + (status.heating ? 'heating' : 'idle'));
            } else if ( key === 'dayandtime_split'){
                let dt = status.dayandtime_split;
                console.log('time: ' + dt.dayname + ' ' + dt.hour + ':' + dt.minute + ':' + dt.second);
            } else if ( key === 'dayandtime'){
                console.log('dayandtime: ' + status.dayandtime);
            } else {
                console.log(key + ' : ' + status[key]);
            }
        }
        console.log('================= summary_status ======================');
        let summary_status = t.summary_status;
        console.log(JSON.stringify(summary_status,null,2));
    }
    process.exit(0);
}
async function status(){
    await initialise();
    await readThermostats();
    console.log('thermostat statuses');
    for(const t of thermostats){
        let s = t.status;
        console.log('frost: ' + s.frostprotectiontemperature +
                    ' set: ' + s.setroomtemperature +
                    ' room: ' + s.airtemperature +
                    ' hold: ' + s.temperatureholdminutes +
                    (s.heating ? 'heating' : '') +
                    ' time: ' + s.dayandtime.dayname + ' ' + s.dayandtime.hour + ':' + s.dayandtime.minute + ':' + s.dayandtime.second);
    }
    process.exit();
}
//async function sleep(ms){
//    return new Promise((resolve, reject) => {
//        let timeout = setTimeout(resolve, ms);
//    });
//}
function minutetime(day, hour, minute){
    return ((day * 24 + hour) * 60 + minute);
}
async function set_time(){
    await initialise();
    await readThermostats();
    for( const t of thermostats){
        t.trace = true;
        let d = new Date();
        let day = d.getDay();
        day = day === 0 ? 7 : day;
        let hour = d.getHours();
        let minute = d.getMinutes();
        let second = d.getSeconds();
        let timenow = minutetime(day, hour, minute);
        //timenow += 5;
        console.log(`Day ${day} ${hour}:${minute}:${second}` );
        let dt = t.status.dayandtime_split;
        console.log(`thermostat: ${t.thermostatID} time: ${JSON.stringify(dt)}`);
        let thermotime = minutetime(dt.day, dt.hour, dt.minute);
        let tdiff = thermotime > timenow ? (thermotime - timenow) : (timenow - thermotime);
        console.log(`timenow: ${timenow} thermotime ${thermotime} tdiff ${tdiff}`);
        if ( tdiff > 1 ){
            console.log(`timenow: ${timenow} thermotime: ${thermotime} tdiff: ${tdiff}`);
            let time_array = [day, hour, minute, second];
            let data = Buffer.from(time_array);
            console.log('Need to update date/time');
            await t.writeSettings(dcblib.dcb_constants.HM_ADDRESS_DAY_AND_TIME, data);
            console.log('updated time');
            t.trace = false;
            await delay(500);
            await t.read();
            dt = t.status.dayandtime;
            console.log(`thermostat: ${t.thermostatID} time: ${JSON.stringify(dt)}`);
        }
    }
    process.exit();
}
const args = process.argv.slice(process.execArgv.length + 2);
for(const arg of args){
    if ( arg === 'publish'){
        publishThermostats().catch((err) => {
            console.log(err.toString());
        });
    }
    if ( arg === 'report'){
        report();
    }
    if ( arg === 'status'){
        status();
    }
    if ( arg === 'settime'){
        set_time();
    }
}
// TODO add http service on 8080
if ( args.length === 0){
    publishThermostats().catch((err) => {
        console.log(err.toString());
    });
}
