const { assert } = require('chai');
const uuid = require('uuid');
const fs = require('fs');
const findKey = require('find-key');

const delayForDuration = require('../helpers/delayForDuration');
const ServiceManagerTypes = require('../helpers/serviceManagerTypes');
const catchDelayCancelError = require('../helpers/catchDelayCancelError');
const { getDevice } = require('../helpers/getDevice');
const BroadlinkRMAccessory = require('./accessory');

class TemperatureSensorAccessory extends BroadlinkRMAccessory {

  constructor (log, config = {}, serviceManagerType) {
    super(log, config, serviceManagerType);

    this.temperatureCallbackQueue = {};
    this.monitorTemperature();
  }

  setDefaults () {
    const { config, state } = this;

    // Set config default values
    config.temperatureUpdateFrequency = config.temperatureUpdateFrequency || 10;
    config.units = config.units ? config.units.toLowerCase() : 'c';
    config.temperatureAdjustment = config.temperatureAdjustment || 0;
    config.humidityAdjustment = config.humidityAdjustment || 0;

    // ignore Humidity if set to not use it, or using Temperature source that doesn't support it
    if(config.noHumidity){
      state.currentHumidity = null;
      config.noHumidity = true;
    } else {
      config.noHumidity = false;
    }

    state.firstTemperatureUpdate = true;
  }

  reset () {
    super.reset();
  }

  // Device Temperature Methods
  async monitorTemperature () {
    const { config, host, log, name, state } = this;
    const { temperatureFilePath, pseudoDeviceTemperature, w1DeviceID } = config;

    if (pseudoDeviceTemperature !== undefined) return;

    //Force w1 and file devices to a 10 minute refresh
    if (w1DeviceID || temperatureFilePath) config.temperatureUpdateFrequency = 600;

    const device = getDevice({ host, log });

    // Try again in a second if we don't have a device yet
    if (!device) {
      await delayForDuration(1);

      this.monitorTemperature();

      return;
    }

    log(`${name} monitorTemperature`);

    device.on('temperature', this.onTemperature.bind(this));
    device.checkTemperature();

    this.updateTemperatureUI();
    if (!config.isUnitTest) setInterval(this.updateTemperatureUI.bind(this), config.temperatureUpdateFrequency * 1000)
  }

  onTemperature (temperature,humidity) {
    const { config, host, log, name, state } = this;
    const { minTemperature, maxTemperature, temperatureAdjustment, humidityAdjustment, noHumidity } = config;

    // onTemperature is getting called twice. No known cause currently.
    // This helps prevent the same temperature from being processed twice
    if (Object.keys(this.temperatureCallbackQueue).length === 0) return;

    temperature += temperatureAdjustment;
    state.currentTemperature = temperature;
    log(`${name} onTemperature (${temperature})`);

    if(humidity) {
      if(noHumidity){
        //noHumidity = false;
        log (`${name} Humidity found, adding support`);
        state.currentHumidity = null;
      }else{
        humidity += humidityAdjustment;
        state.currentHumidity = humidity;
        log(`${name} onHumidity (` + humidity + `)`);
      }
    }

    this.processQueuedTemperatureCallbacks(temperature);
  }

  addTemperatureCallbackToQueue (callback) {
    const { config, host, debug, log, name, state } = this;
    
    // Clear the previous callback
    if (Object.keys(this.temperatureCallbackQueue).length > 1) {
      if (state.currentTemperature) {
        if (debug) log(`\x1b[34m[DEBUG]\x1b[0m ${name} addTemperatureCallbackToQueue (clearing previous callback, using existing temperature)`);

        this.processQueuedTemperatureCallbacks(state.currentTemperature);
      }
    }

    // Add a new callback
    const callbackIdentifier = uuid.v4();
    this.temperatureCallbackQueue[callbackIdentifier] = callback;

    // Read temperature from Broadlink RM device
    // If the device is no longer available, use previous tempeature
    const device = getDevice({ host, log });

    if (!device || device.state === 'inactive') {
      if (device && device.state === 'inactive') {
        log(`${name} addTemperatureCallbackToQueue (device no longer active, using existing temperature)`);
      }

      this.processQueuedTemperatureCallbacks(state.currentTemperature || 0);

      return;
    }

    device.checkTemperature();
    if (debug) log(`\x1b[34m[DEBUG]\x1b[0m ${name} addTemperatureCallbackToQueue (requested temperature from device, waiting)`);
  }

  processQueuedTemperatureCallbacks (temperature) {
    if (Object.keys(this.temperatureCallbackQueue).length === 0) return;

    Object.keys(this.temperatureCallbackQueue).forEach((callbackIdentifier) => {
      const callback = this.temperatureCallbackQueue[callbackIdentifier];

      callback(null, temperature);
      delete this.temperatureCallbackQueue[callbackIdentifier];
    })

    this.temperatureCallbackQueue = {};
  }

  updateTemperatureUI () {
    const { config, serviceManager } = this;
    const { noHumidity } = config;

    serviceManager.refreshCharacteristicUI(Characteristic.CurrentTemperature);
    if(!noHumidity){serviceManager.refreshCharacteristicUI(Characteristic.CurrentRelativeHumidity);};
  }

  getCurrentTemperature (callback) {
    const { config, host, debug, log, name, state } = this;
    const { pseudoDeviceTemperature } = config;

    // Some devices don't include a thermometer and so we can use `pseudoDeviceTemperature` instead
    if (pseudoDeviceTemperature !== undefined) {
      if (debug) log(`\x1b[34m[DEBUG]\x1b[0m ${name} getCurrentTemperature (using pseudoDeviceTemperature ${pseudoDeviceTemperature} from config)`);

      return callback(null, pseudoDeviceTemperature);
    }

    this.addTemperatureCallbackToQueue(callback);
  }

  getCurrentHumidity (callback) {
    const { config, host, debug, log, name, state } = this;
    const { pseudoDeviceTemperature } = config;

    return callback(null, state.currentHumidity);
  }

  getTemperatureDisplayUnits (callback) {
    const { config } = this;

    const temperatureDisplayUnits = (config.units.toLowerCase() === 'f') ? Characteristic.TemperatureDisplayUnits.FAHRENHEIT : Characteristic.TemperatureDisplayUnits.CELSIUS;

    callback(temperatureDisplayUnits);
  }

  
  // Service Manager Setup

  setupServiceManager () {
    const { config, name, serviceManagerType } = this;

    this.serviceManager = new ServiceManagerTypes[serviceManagerType](name, Service.HumiditySensor, this.log);

    this.serviceManager.addGetCharacteristic({
      name: 'currentTemperature',
      type: Characteristic.CurrentTemperature,
      method: this.getCurrentTemperature,
      bind: this
    });
	
	 

    if (!config.noHumidity){
      this.serviceManager.addGetCharacteristic({
        name: 'currentHumidity',
        type: Characteristic.CurrentRelativeHumidity,
        method: this.getCurrentHumidity,
        bind: this
      })
    };

    this.serviceManager.addGetCharacteristic({
      name: 'temperatureDisplayUnits',
      type: Characteristic.TemperatureDisplayUnits,
      method: this.getTemperatureDisplayUnits,
      bind: this
    })

    this.serviceManager
      .getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({
        minStep: 0.1
      });
	  
	      this.serviceManager
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .setProps({
        minStep: 0.1
      });
	  
  }
}

module.exports = TemperatureSensorAccessory