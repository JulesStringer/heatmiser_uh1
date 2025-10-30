const fs = require('fs');
const mqtt = require('mqtt');

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function loadJSON(filepath){
    let data = await fs.promises.readFile(filepath);
    return JSON.parse(data);
}
const mqtt_broker_file = '/home/jules/.credentials/mqtt/mqtt_broker.json';
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
async function test(){
    const args = process.argv.splice(2);
    let topic = 'heatmiser/#';
    for(const arg of args){
        if ( arg.startsWith('topic=')){
            topic = arg.split('=')[1];
        }
    }
    let mqtt_client = await connect_mqtt();
    mqtt_client.subscribe(topic);
    mqtt_client.on('message', function(topic, message){
        let d = message.toString();
        console.log(topic + ' : ' + d);
    });
}
test().then(()=> {
    console.log('Finished')
}).catch((err)=>{
    console.error(err.toString());
})