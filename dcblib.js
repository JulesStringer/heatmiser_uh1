// this file contains functions to:
// Read a thermostat's DCB
// Send a request to a thermostat
//
const SerialPort = require('serialport').SerialPort;
const Readline = require('@serialport/parser-readline');
const os = require('os');
const {RetryPolicy} = require('./retry_policy.js');
const E_TIMEOUT = require('./retry_policy.js').E_TIMEOUT;
const {Mutex} = require('async-mutex');

function getCRC(buffer) {
    // Lookup tables for the CRC calculation
    const LookupHigh = [0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70,
                        0x81, 0x91, 0xA1, 0xB1, 0xC1, 0xD1, 0xE1, 0xF1];
    const LookupLow = [0x00, 0x21, 0x42, 0x63, 0x84, 0xA5, 0xC6, 0xE7,
                       0x08, 0x29, 0x4A, 0x6B, 0x8C, 0xAD, 0xCE, 0xEF];

    // Initialize the CRC high and low registers
    let m_High = 0xFF;
    let m_Low = 0xFF;

    // Function to update the CRC with 4-bit chunks
    function update4Bits(val) {
        let t = m_High >> 4;
        t ^= val;
        m_High = ((m_High << 4) | (m_Low >> 4)) & 0xFF;
        m_Low = (m_Low << 4) & 0xFF;

        m_High ^= LookupHigh[t];
        m_Low ^= LookupLow[t];
    }
    // Function to update the CRC with 1 byte (8 bits)
    function update(val) {
        update4Bits(val >> 4);
        update4Bits(val & 0x0F);
    }
    
    // Compute the CRC for the given buffer (using buffer's length directly)
    for (let i = 0; i < buffer.length; i++) {
        update(buffer[i]);
    }
    // Return the final CRC high and low bytes
    return { high: m_High, low: m_Low };
}
class RS485BusManager {
    constructor(rxport, txport, trace = false) {
        // 1. OWN the shared resources
        this.rxport = rxport;
        this.txport = txport;
        this.accessMutex = new Mutex();
        this.trace = trace;
    }

    // 2. Publicly expose the safe access method
    async accessBus(operationFunction) {
        const release = await this.accessMutex.acquire();
        try {
            return await operationFunction();
        } finally {
            release();
        }
    }
    log(msg){
        if ( this.trace){
            console.log(msg);
        }
    }
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    async send_request(request, on_data, timeoutMs = 2000, log = console.log) { // Add log for debugging
        return await this.accessBus(async () => {
            await this.delay(50);


            return new Promise(async (resolve, reject) => {    
                let timeoutId;

                const cleanupAndResolve = (result) => {
                    clearTimeout(timeoutId);
                    this.rxport.removeAllListeners('data');
                    this.txport.drain(() => {
                        this.rxport.flush();
                        this.txport.flush();
                        resolve(result);
                    });
                };
                const cleanupAndReject = (error) => {
                    clearTimeout(timeoutId);
                    this.rxport.removeAllListeners('data');
                    this.txport.drain(() => {
                        this.rxport.flush();
                        this.txport.flush();
                        reject(error);
                    });
                };
                this.rxport.removeAllListeners('data');
                this.txport.flush();
                this.rxport.flush();
                //this.log('About to write request: ' + request.toString('hex'));
                let responseBuffer = Buffer.alloc(0);
                // Use an arrow function for proper 'this' binding
                const dataHandler = (data) => {
                    responseBuffer = Buffer.concat([responseBuffer, data]);
                    try {
                        // 3. Call the Thermostat's logic (on_data) to check for a full packet.
                        //    - Thermostat returns the valid response data OR null.
                        let result = on_data(responseBuffer); 
                        if (result !== null && result !== undefined) {
                            //console.log('result :' + result.toString('hex'));
                            // Packet is complete and valid!
                            // 4. Cleanup and Resolve the outer Promise
                            cleanupAndResolve(result);
                        } 
                        // If result is null/undefined, we know the packet is incomplete, so we keep listening.
                        
                    } catch (err) {
                        // CRC mismatch or invalid format error thrown by on_data
                        cleanupAndReject(err);
                    }
                }
                this.rxport.on('data', dataHandler);

                timeoutId = setTimeout(() => {
                    const err = new Error("Transaction timed out internally. (T-Stat unresponsive)");
                    err.code = "E_TIMEOUT_INTERNAL";
                    cleanupAndReject(err);
                }, timeoutMs); // <--- USE THE PASSED TIMEOUT VALUE

                this.txport.write(request, (err) => {
                    if (err) {
                        //reject(`Error writing to port: ${err.message}`);
                        cleanupAndReject(err);
                    }
                    //console.log('Written request: ' + request.toString('hex'));
                    this.log('request: ' + request.toString('hex'));
                });
            });
        });
    }
}
exports.RS485BusManager = RS485BusManager;
const TOO_MANY_RETRIES = "Too many retries - giving up";
const dcb_constants = {
    HM_ADDRESS_FROST_PROTECTION_TEMPERATURE:17,
    HM_ADDRESS_SET_ROOM_TEMPERATURE:        18,
    HM_ADDRESS_RUNMODE:                     23,
    HM_ADDRESS_HOLIDAY_HOURS:               24,
    HM_ADDRESS_TEMPERATURE_HOLD_MINUTES:    32,
    HM_ADDRESS_DAY_AND_TIME:                43,
    HM_ADDRESS_WEEKDAY_SCHEDULE:            47,
    HM_ADDRESS_WEEKEND_SCHEDULE:            59
}
exports.dcb_constants = dcb_constants;
const dcb_address_lookup = {
    "frostprotectiontemperature":   {address:17,   length: 1},
	"setroomtemperature":       	{address:18,   length: 1},
	"runmode":                  	{address:23,   length: 1},
	"holidayhours":             	{address:24,   length: 2},
	"temperatureholdminutes":   	{address:32,   length: 2},
	"dayandtime":              	    {address:43,   length: 4},
	"weekdayschedule":	            {address:47,   length: 12},
	"weekendschedule":          	{address:59,   length: 12}
};
class Thermostat {
    constructor(thermostatID, masterID, rs485bus_manager, trace = false, echo = false) {
        this.thermostatID = thermostatID;  // ID of the thermostat
        this.masterID = masterID;          // ID of the sender (master)
        rs485bus_manager.trace = trace;
        this.rs485bus_manager = rs485bus_manager,
        this.timeout = 2000;               // 2-second timeout for responses
        this.trace = trace;
        this.echo = echo;
    }
    log(msg){
        if ( this.trace){
            console.log(msg);
        }
    }
    // Create a packet with the format provided
    createRequest(commandType, dcbAddress, dataLength, data = []) {
        const header = Buffer.alloc(8);

        // Byte 0: Thermostat ID
        header[0] = this.thermostatID;
        
        // Byte 1: Length of the entire packet including header + data
        header[1] = 10 + data.length;  // Header is 10 bytes, plus data length

        // Byte 2: ID of the sender (Master ID)
        header[2] = this.masterID;

        // Byte 3: Command (0 = Read, 1 = Write)
        header[3] = commandType;

        // Bytes 4-5: Address in the DCB to read/write (2 bytes)
        header.writeUInt16LE(dcbAddress, 4);

        // Bytes 6-7: Length of data to copy to DCB (0xFFFF for read, otherwise data length)
        header.writeUInt16LE(dataLength, 6);

        // Combine header and data (if any) into the request buffer
        const request = Buffer.concat([header, Buffer.from(data)]);

        // Append CRC (2 bytes) at the end
        const crc = getCRC(request);
//this.log('crc: ' + JSON.stringify(crc));
        const crcBuffer = Buffer.from([crc.low & 0xff, crc.high & 0xff]);
//this.log('crcBuffer: ' + crcBuffer[0] + ' ' + crcBuffer[1]);
        // Final request with CRC
        return Buffer.concat([request, crcBuffer]);
    }

    // Send a request (read or write) and handle the response
    async sendRequest(commandType, dcbAddress, dataLength, data = []) {
        const request = this.createRequest(commandType, dcbAddress, dataLength, data);
        this.log(`Sending request to thermostat ${this.thermostatID}`);
        const retry_policy = new RetryPolicy(5, this.timeout, 'Read response timeout');
        try {
            return await retry_policy.retry(this.writeAndReadResponse.bind(this), request);
        } catch (error) {
            if ( error.code === E_TIMEOUT){
                console.error(TOO_MANY_RETRIES);
                process.exit(-1);
            }
            throw(error);
        }
    }

    // Send a ReadDCB request
    async ReadDCB() {
        const commandType = 0x00;  // Read command
        const dataLength = 0xFFFF;  // Read command uses 0xFFFF
        return await this.sendRequest(commandType, 0, dataLength);
    }

    // Send a write request with data
    async writeSettings(dcbAddress, data) {
        const commandType = 0x01;  // Write command
        const dataLength = data.length;  // Length of data to write
        const request = this.createRequest(commandType, dcbAddress, dataLength, data);
        this.log(`Sending request to thermostat ${this.thermostatID}`);
        const retry_policy = new RetryPolicy(5, this.timeout, 'Update response timeout');
        try {
            return await retry_policy.retry(this.writeUpdateRequest.bind(this), request);
        } catch (error) {
            if ( error.code === E_TIMEOUT){
                console.error(TOO_MANY_RETRIES);
                process.exit(-1);
            }
            throw(error);
        }
    }
    async update(update_spec){
        for(const key in update_spec){
            let addr = dcb_address_lookup[key];
            if ( addr ){
                let data = update_spec[key];
                if ( !Array.isArray(data)){
                    data = [data];
                    if ( addr.length == 2){
                        let hi = data >> 8;
                        let lo = data & 0xFF;
                        data = [lo, hi];
                    }
                }
                await this.writeSettings(addr.address, data);
            }
        }
    }
    async writeUpdateRequest(request){
        return await this.rs485bus_manager.send_request(request, (data) => {
            // response to a write packet is just 7 bytes
            if ( data.length >= 7){
                const crcReceived = data.readUInt16LE(5);
                const crc = getCRC( data.slice(0, 5));
                const crcCalculated = crc.high << 8 | (crc.low & 0xFF);
                if (crcReceived === crcCalculated) {
                    this.log('Packet accepted');
                    return true;
                } else {
                    const err = new Error('CRC mismatch, discarding response, crcReceived: ' + crcReceived + ' crcCalculated: ' + crcCalculated);
                    this.log(err.toString());
                    throw(err);
                }
            }
            return null;
        });
    }
    // Function to write the request and read the response
    async writeAndReadResponse(request) {
        return await this.rs485bus_manager.send_request(request, (data) => {
            if ( data.length >= 11){
                // Wait until at least 11 bytes (header) + response data length + 2 CRC bytes are received
                const header = data.slice(0, 11);
                //console.log('Header was ' + header.toString('hex'));
                const dataLength = header.readUInt16LE(1) - 11;  // Extract data length from header
                //console.log('dataLength: ' + dataLength);
                const expectedLength = 9 + dataLength + 2;  // Total length with CRC
                this.log('expectedLength: ' + expectedLength + ' received so far : ' + data.length);
                if ( data.length >= expectedLength) {
                    const dcb = data.slice(9, expectedLength - 2);
                    const crcReceived = data.readUInt16LE(expectedLength - 2);
                    const crc = getCRC(data.slice(0, expectedLength - 2));
                    const crcCalculated = crc.high << 8 | (crc.low & 0xFF);
                    //console.log(` crc: ${crcCalculated} crcReceived: ${crcReceived} `);
                    if (crcReceived === crcCalculated) {
                        if ( header[3] != this.thermostatID){
                            let err = new Error('Received dcb for ' + header[3] + ' requested thermostat ' +this.thermostatID);
                            throw(err);
                        } else {
                            //console.log(`Received valid response from thermostat ${this.thermostatID}`);
                            for(let i = 0; i < dcb.length; i += 10){
                                let t = dcb.slice(i, i + 10);
                                this.log(i + ' : ' + t.toString('hex'));
                            }
                            //console.log('dcb length: ' + (dcb[0] << 8 | dcb[1]));
                            return dcb;  // Return the DCB data
                        }
                    } else {
                        const err = new Error('CRC mismatch, discarding response, crcReceived: ' + crcReceived + ' crcCalculated: ' + crcCalculated);
                        throw err;
                    }
                }
            }
            return null;
        });
    }
    decodesensors(dcb){
        let s = {
            builtin: false,
            remote: false,
            floor: false
        }
        switch(dcb[13]){
            case 0: s.builtin = true; break;
            case 1: s.remote = true; break;
            case 2: s.floor = true; break;
            case 3: s.builtin = true; s.floor = true; break;
            case 4: s.remote = true; s.floor; break;
        }
        return s; 
    }
    decodetemperature(high, low){
        return parseFloat(high << 8 | low)/10;
    }
    pad(digits, number){
        return number.toString().padStart(digits,'0');
    }
    decodestatus(dcb){
        const days = ['','mon','tue','wed','thu','fri','sat','sun'];
        let status = {};
        status.frostprotectiontemperature = dcb[17];
        status.setroomtemperature = dcb[18];
        status.runmode = dcb[23] ? 'frost' : 'normal';
        status.temperatureholdminutes = dcb.readUInt16BE(26);
        let hassensor = this.decodesensors(dcb);
        if ( hassensor.remote ){
            status.remoteairtemperature = this.decodetemperature(dcb[28], dcb[29]);
        }
        if ( hassensor.floor ){
            status.floorairtemperature =  this.decodetemperature(dcb[30], dcb[31]);
        }
        if ( hassensor.builtin ){
            status.builtinairtemperature =  this.decodetemperature(dcb[32], dcb[33]);
        }
        status.airtemperature = status.builtinairtemperature;
        if ( hassensor.remote ){
            status.airtemperature = status.remoteairtemperature;
        }
        if ( dcb[34] ){
            status.sensorerror = dcb[34];
        }
        status.heating = dcb[35];
        status.dayandtime = `${dcb[36]}T${this.pad(2,dcb[37])}:${this.pad(2,dcb[38])}:${this.pad(2,dcb[39])}`;
        status.dayandtime_split = {
            day: dcb[36],
            dayname: days[dcb[36]],
            hour: dcb[37],
            minute: dcb[38],
            second: dcb[39]
        }
        status.hostname = os.hostname();
        return status;
    }
    form_timestamp(dcb){
        let d = new Date();
        if ( d.getDay() !== dcb[36] % 7){
            let dayDifference = (dcb[36] % 7) - d.getDay();
            if ( dayDifference < -3){
                dayDifference += 7;
            } else if ( dayDifference > 3){
                dayDifference -= 7;
            }
            let t = d.getTime() + dayDifference * 24*60*60*1000;
            d = new Date(t);
        }
        let year = d.getFullYear();
        let month = d.getMonth();
        let dmon = d.getDate();
        let hour = dcb[37];
        let minute = dcb[38];
        let second = dcb[39];
        d = new Date(year,month,dmon,hour,minute,second);
        let ts = d.toISOString();
        return ts.split('.')[0];
    }
    decode_status_summary(dcb){
        let status = {};
        status.id = this.thermostatID;
        status.frost = dcb[17];
        status.setroom = dcb[18];
        let hassensor = this.decodesensors(dcb);
        if ( hassensor.remote ){
            status.air = this.decodetemperature(dcb[28], dcb[29]);
        } else {
            status.air = this.decodetemperature(dcb[32], dcb[33]);
        }
        status.state = 0;
        if ( dcb[35]){
            status.state = 1;
        }
        if ( dcb[23] ){
            status.state = 2;
        }
        let d = new Date();
        if ( d.getDay() === dcb[36] % 7){
            // on same day

        } else {
            let dayDifference = (dcb[36] % 7) - d.getDay();
            if ( dayDifference < -3){
                dayDifference += 7;
            } else if ( dayDifference > 3){
                dayDifference -= 7;
            }
            let t = d.getTime() + dayDifference * 24*60*60*1000;
            d = new Date(t);
        }
        status.timestamp = this.form_timestamp(dcb);
        status.hostname = os.hostname();
        return status;
    }
    compare_status_summary(status_summary){
        if ( this.status_summary.state != status_summary.state){
            return true;
        }
        if ( this.status_summary.frost != status_summary.frost){
            return true;
        }
        if ( this.status_summary.setroom != status_summary.setroom){
            return true;
        }
        if ( this.status_summary.air != status_summary.air){
            return true;
        }
        return false;
    }
    decodeconfig(dcb){
        let config = {};
        config.vendor = dcb[2] ? 'OEM' : 'HEATMISER';
        config.version = dcb[3] & 0x7f;
        config.floorlimitstate = dcb[3] >> 7;
        config.model = dcb[4];
        switch(dcb[4]){
            case 0: config.model = 'DT'; break;
            case 1: config.model = 'DT/E'; break;
            case 2: config.model = 'PRT'; break;
            case 3: config.model = 'PRT/E'; break;
        }
        config.temperatureformat = dcb[5] ? 'F' : 'C';
        config.switchdifferential = dcb[6];
        config.frostprotectionenable = dcb[7];
        config.calibrationoffset = dcb.readUInt16BE(8);
        config.outputdelay = dcb[10]; 
        config.address = dcb[11];
        config.updownkeylimit = dcb[12];
        config.sensor = this.decodesensors(dcb);
        config.optimumstart = dcb[14];
        config.rateofchange = dcb[15];
        config.programmode = dcb[16] ? '7 day' : '5/2 mode';
        config.floorlimit = dcb[20];
        config.floorlimitenable = dcb[21];
        config.on = dcb[22] ? 'on' : 'off';
        config.keylock = dcb[23] ? 'lock' : 'unlock';
        config.holidayhours = dcb.readUInt16BE(24);
        config.hostname = os.hostname();
        return config;
    }
// 0 FrostProtectionEnable
// 1 FrostProtectionTemperature
// 2 SetRoomTemperature
// 3 RunMode
// 4 Holiday hours - 16bit
// 5 Day + Time - 32 bit         - set by out of step with timeservice
// 6 Weekday schedule - 12 bytes - set by ID
// 7 Weekend schedule - 12 bytes
// 8 Temperature hold minutes 16bit
/*
typedef struct tagUPDATEDEF
{
	uint16_t m_nAddress;
	uint8_t m_nLen;
	uint8_t m_nUpdateAddress;
	char m_szName[32];
}UPDATEDEF;
const UPDATEDEF c_updateDefs[MAX_UPDATE_FIELD] = {
		7,	1, 0, "FrostProtectionEnable",     // FrostProtectionEnable - by experiment this seems to do nothing?
		17, 1, 1, "FrostProtectionTemperature",// FrostProtectionTemperature
		18, 1, 2, "SetRoomTemperature",        // SetRoomTemperature
		23, 1, 3, "RunMode",                   // RunMode
		24, 2, 4, "HolidayHours",              // Holiday hours
		43, 4, 6, "DayAndTime",                // Day + Time
		47, 12,10,"WeekdaySchedule",           // Weekday schedule
		59, 12,22,"WeekendSchedule",           // Weekend schedule
		32, 2, 34,"TemperatureHoldMinutes"     // Temperature hold minutes
};
*/
    /*
    async set_status(status){
        // needs class to form dcb append fields to it?
    }
    async set_schedule(schedule)
    */
    decodescheduleperiod(dcb, offset){
        let times = [];
        let o = offset;
        for(let i = 0; i < 4; i++, o+= 3){
            let time = {
                hour: dcb[o],
                minute: dcb[o+1],
                temperature: dcb[o+2]
            }
            times.push(time);
        }
        return times;
    }
    decodeschedule(dcb){
        let schedule = {};
        let offset = 40;
        const modes = ['week','weekend'];
        for(const mode of modes){
            schedule[mode] = this.decodescheduleperiod(dcb, offset);
            offset += 12;
        }
        if ( dcb[16]){
            offset = 64;
            const days = ['mon','tue','wed','thu','fri','sat','sun'];
            for(const day of days){
                schedule[day] = this.decodescheduleperiod(dcb, offset);
                offset += 12;
            }
        }
        schedule.hostname = os.hostname();
        return schedule;
    }
    decode(dcb){
        this.config = this.decodeconfig(dcb);
        this.status = this.decodestatus(dcb);
        this.schedule = this.decodeschedule(dcb);
        this.summary_status = this.decode_summary_status(dcb);
    }
    async delay(ms){
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    async read(){
        let dcb = await this.ReadDCB().catch((err) => {
            console.log(err.toString());

        });
        if ( dcb ){
            this.config = this.decodeconfig(dcb);
            this.status = this.decodestatus(dcb);
            this.schedule = this.decodeschedule(dcb);
            this.status_summary = this.decode_status_summary(dcb);
        }
    }
}
exports.Thermostat = Thermostat;


