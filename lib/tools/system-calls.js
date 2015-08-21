import path from 'path';
import log from '../logger.js';
import B from 'bluebird';
import { system, util } from 'appium-support';
import { getDirectories } from '../helpers';
import { exec } from 'teen_process';
import { sleep, retry, retryInterval } from 'asyncbox';
import { SubProcess } from 'teen_process';

let systemCallMethods = {};

systemCallMethods.getSdkBinaryPath = async function (binaryName) {
  log.info(`Checking whether ${binaryName} is present`);
  if (this.sdkRoot) {
    return this.getBinaryFromSdkRoot(binaryName);
  } else {
    log.warn(`The ANDROID_HOME environment variable is not set to the Android SDK ` +
             `root directory path. ANDROID_HOME is required for compatibility ` +
             `with SDK 23+. Checking along PATH for ${binaryName}.`);
    return this.getBinaryFromPath(binaryName);

  }
};

systemCallMethods.getCommandForOS = function (binaryName) {
  let cmd = "which";
  if (system.isWindows()) {
    if (binaryName === "android") {
      binaryName += ".bat";
    } else {
      if (binaryName.indexOf(".exe", binaryName.length - 4) === -1) {
        binaryName += ".exe";
      }
    }
    cmd = "where";
  }
  return cmd;
};

systemCallMethods.getBinaryFromSdkRoot = async function (binaryName) {
  let binaryLoc = null;
  let binaryLocs = [path.resolve(this.sdkRoot, "platform-tools", binaryName),
                    path.resolve(this.sdkRoot, "tools", binaryName)];
  // get subpaths for currently installed build tool directories
  let buildToolDirs = [];
  buildToolDirs = await getDirectories(path.resolve(this.sdkRoot, "build-tools"));
  for (let versionDir of buildToolDirs) {
    binaryLocs.push(path.resolve(this.sdkRoot, "build-tools", versionDir, binaryName));
  }
  for (let loc of binaryLocs) {
    let flag = await util.fileExists(loc);
    if (flag) {
      binaryLoc = loc;
    }
  }
  if (binaryLoc === null) {
    throw new Error(`Could not find ${binaryName} in tools, platform-tools, ` +
                    `or supported build-tools under ${this.sdkRoot} ` +
                    `do you have the Android SDK installed at this location?`);
  }
  binaryLoc = binaryLoc.trim();
  log.info(`Using ${binaryName} from ${binaryLoc}`);
  return binaryLoc;
};

systemCallMethods.getBinaryFromPath = async function (binaryName) {
  let binaryLoc = null;
  let cmd = this.getCommandForOS(binaryName);
  try {
    let {stdout} = await exec(cmd, [binaryName]);
    log.info(`Using ${binaryName} from ${stdout}`);
    // TODO write a test for binaries with spaces.
    binaryLoc = stdout.trim();
    return binaryLoc;
  } catch(e) {
    log.errorAndThrow(`Could not find ${binaryName} Please set the ANDROID_HOME ` +
              `environment variable with the Android SDK root directory path.`);
  }
};

systemCallMethods.getConnectedDevices = async function () {
  log.debug("Getting connected devices...");
  try {
    let {stdout} = await exec(this.executable.path, ['devices']);
    // expecting adb devices to return output as
    // List of devices attached
    // emulator-5554	device
    let startingIndex = stdout.indexOf("List of devices");
    if (startingIndex === -1) {
      throw new Error(`Unexpected output while trying to get devices. output was: ${stdout}`);
    } else {
      // slicing ouput we care about.
      stdout = stdout.slice(startingIndex);
      let devices = [];
      for (let line of stdout.split("\n")) {
        if (line.trim() !== "" &&
            line.indexOf("List of devices") === -1 &&
            line.indexOf("* daemon") === -1 &&
            line.indexOf("offline") === -1) {
          let lineInfo = line.split("\t");
          // state is either "device" or "offline", afaict
          devices.push({udid: lineInfo[0], state: lineInfo[1]});
        }
      }
      log.debug(`${devices.length} device(s) connected`);
      return devices;
    }
  } catch (e) {
    log.errorAndThrow(`Error while getting connected devices. Original error: ${e.message}`);
  }
};

systemCallMethods.getDevicesWithRetry = async function (timeoutMs = 20000) {
  let start = Date.now();
  log.debug("Trying to find a connected android device");
  let getDevices = async () => {
    if ((Date.now() - start) > timeoutMs) {
      throw new Error("Could not find a connected Android device.");
    }
    try {
      let devices = await this.getConnectedDevices();
      if (devices.length < 1) {
        log.debug("Could not find devices, restarting adb server...");
        await this.restartAdb();
        // cool down
        await sleep(200);
        return getDevices();
      }
      return devices;
    } catch (e) {
      log.debug("Could not find devices, restarting adb server...");
      await this.restartAdb();
      // cool down
      await sleep(200);
      return getDevices();
    }
  };
  return getDevices();
};

systemCallMethods.restartAdb = async function () {
  if (!this.suppressKillServer) {
    try {
      await exec(this.executable.path, ['kill-server']);
    } catch (e) {
      log.error("Error killing ADB server, going to see if it's online anyway");
    }
  }
};

systemCallMethods.adbExec = async function (cmd, opts = {}) {
  if (!cmd) {
    throw new Error("You need to pass in a command to adbExec()");
  }
  // setting default timeout for each command to prevent infinite wait.
  opts.timeout = opts.timeout || 20000;
  let execFunc = async () => {
    try {
      if (!(cmd instanceof Array)) {
        cmd = [cmd];
      }
      let {stdout} = await exec(this.executable.path,
                                this.executable.defaultArgs.concat(cmd), opts);
      // sometimes ADB prints out stupid stdout warnings that we don't want
      // to include in any of the response data, so let's strip it out
      let linkerWarningRe = /^WARNING: linker.+$/m;
      stdout = stdout.replace(linkerWarningRe, '').trim();
      return stdout;
    } catch (e) {
      let protocolFaultError = new RegExp("protocol fault \\(no status\\)", "i").test(e);
      let deviceNotFoundError = new RegExp("error: device not found", "i").test(e);
      if (protocolFaultError || deviceNotFoundError) {
        log.info(`error sending command, reconnecting device and retrying: ${cmd}`);
        await sleep(1000);
        await this.getDevicesWithRetry();
      }
      log.errorAndThrow(`Error executing adbExec. Original error: ${e.message}` +
                        JSON.stringify(e));
    }
  };
  return retry(2, execFunc);
};

systemCallMethods.shell = async function (cmd) {
  if (!await this.isDeviceConnected()) {
    throw new Error(`No device connected, cannot run adb shell command "${cmd.join(' ')}"`);
  }
  let execCmd = ['shell'];
  if (cmd instanceof Array) {
    execCmd = execCmd.concat(cmd);
  } else {
    execCmd.push(cmd);
  }
  return this.adbExec(execCmd);
};

systemCallMethods.getAdbServerPort = function () {
  return process.env.ANDROID_ADB_SERVER_PORT || 5037;
};

systemCallMethods.getEmulatorPort = async function () {
  log.debug("Getting running emulator port");
  if (this.emulatorPort !== null) {
    return this.emulatorPort;
  }
  try {
    let devices = await this.getConnectedDevices();
    let port = this.getPortFromEmulatorString(devices[0].udid);
    if (port) {
      return port;
    } else {
      throw new Error(`Emulator port not found`);
    }
  } catch (e) {
    log.errorAndThrow(`No devices connected. Original error: ${e.message}`);
  }
};

systemCallMethods.getPortFromEmulatorString = function (emStr) {
  let portPattern = /emulator-(\d+)/;
  if (portPattern.test(emStr)) {
    return parseInt(portPattern.exec(emStr)[1], 10);
  }
  return false;
};

systemCallMethods.getConnectedEmulators = async function () {
  try {
    log.debug("Getting connected emulators");
    let devices = await this.getConnectedDevices();
    let emulators = [];
    for (let device of devices) {
      let port = this.getPortFromEmulatorString(device.udid);
      if (port) {
        device.port = port;
        emulators.push(device);
      }
    }
    log.debug(`${emulators.length} emulator(s) connected`);
    return emulators;
  } catch (e) {
    log.errorAndThrow(`Error getting emulators. Original error: ${e.message}`);
  }
};

systemCallMethods.setEmulatorPort = function (emPort) {
  this.emulatorPort = emPort;
};

systemCallMethods.setDeviceId = function (deviceId) {
  log.debug(`Setting device id to ${deviceId}`);
  this.curDeviceId = deviceId;
  this.executable.defaultArgs.push("-s", deviceId);
};

systemCallMethods.setDevice = function (deviceObj) {
  let deviceId = deviceObj.udid;
  let emPort = this.getPortFromEmulatorString(deviceId);
  this.setEmulatorPort(emPort);
  this.setDeviceId(deviceId);
};

systemCallMethods.getRunningAVD = async function (avdName) {
  try {
    log.debug(`Trying to find ${avdName} emulator`);
    let emulators = await this.getConnectedEmulators();
    if (emulators.length < 1) {
      throw new Error("No emulators connected");
    }
    for (let emulator of emulators) {
      this.setEmulatorPort(emulator.port);
      let runningAVDName = await this.sendTelnetCommand("avd name");
      if (avdName === runningAVDName) {
        log.debug(`Found emulator ${avdName} in port ${emulator.port}`);
        this.setDeviceId(emulator.udid);
        return emulator;
      }
    }
    log.debug(`Emulator ${avdName} not running`);
    return null;
  } catch (e) {
    log.errorAndThrow(`Error getting AVD. Original error: ${e.message}`);
  }
};

systemCallMethods.getRunningAVDWithRetry = async function (avdName, timeoutMs = 20000) {
  try {
    let start = Date.now();
    while ((Date.now() - start) < timeoutMs) {
      try {
        let runningAVD = await this.getRunningAVD(avdName.replace('@', ''));
        if (runningAVD) {
          return runningAVD;
        }
      } catch (e) {
        // Do nothing.
        log.info(`Couldn't get running AVD, will retry. Error was: ${e.message}`);
      }
      // cool down
      await sleep(200);
    }
    log.errorAndThrow(`Could not find ${avdName} emulator.`);
  } catch (e) {
    log.errorAndThrow(`Error getting AVD with retry. Original error: ${e.message}`);
  }
};

systemCallMethods.killAllEmulators = async function () {
  let cmd, args;
  if (system.isWindows()) {
    cmd = 'TASKKILL';
    args = ['TASKKILL' ,'/IM', 'emulator.exe'];
  } else {
    cmd = '/usr/bin/killall';
    args = ['-m', 'emulator*'];
  }
  try {
    await exec(cmd, args);
  } catch (e) {
    log.errorAndThrow(`Error killing emulators. Original error: ${e.message}`);
  }
};

systemCallMethods.launchAVD = async function (avdName, avdArgs, language, locale,
  avdLaunchTimeout = 60000, avdReadyTimeout = 60000, retryTimes = 1) {
  log.debug(`Launching Emulator with AVD ${avdName}, launchTimeout` +
            `${avdLaunchTimeout} ms and readyTimeout ${avdReadyTimeout} ms`);
  let emulatorBinaryPath = await this.getSdkBinaryPath("emulator");
  if (avdName[0] === "@") {
    avdName = avdName.substr(1);
  }
  let launchArgs = ["-avd", avdName];
  if (typeof language === "string") {
    log.debug(`Setting Android Device Language to ${language}`);
    launchArgs.push("-prop", `persist.sys.language=${language.toLowerCase()}`);
  }
  if (typeof locale === "string") {
    log.debug(`Setting Android Device Country to ${locale}`);
    launchArgs.push("-prop", `persist.sys.country=${locale.toUpperCase()}`);
  }
  if (typeof avdArgs === "string") {
    avdArgs = avdArgs.split(" ");
    launchArgs = launchArgs.concat(avdArgs);
  }
  let proc = new SubProcess(emulatorBinaryPath, launchArgs);
  await proc.start(0);
  proc.on('output', (stdout, stderr) => {
    log.info(`[AVD OUTPUT] ${stdout || stderr}`);
  });
  await retry(retryTimes, this.getRunningAVDWithRetry.bind(this), avdName, avdLaunchTimeout);
  await this.waitForEmulatorReady(avdReadyTimeout);
  return proc;
};

systemCallMethods.waitForEmulatorReady = async function (timeoutMs = 20000) {
  let start = Date.now();
  log.debug("Waiting until emulator is ready");
  while ((Date.now() - start) < timeoutMs) {
    try {
      let stdout = await this.shell(["getprop", "init.svc.bootanim"]);
      if (stdout.indexOf('stopped') > -1) {
        return;
      }
    } catch (e) {
      // do nothing
    }
    await sleep(3000);
  }
  log.errorAndThrow('Emulator not ready');
};

systemCallMethods.waitForDevice = async function (appDeviceReadyTimeout = 30) {
  this.appDeviceReadyTimeout = appDeviceReadyTimeout;
  let retries = 3;
  await retry(retries, async () => {
    const timeoutSecs = parseInt(this.appDeviceReadyTimeout, 10);
    try {
      await this.adbExec('wait-for-device', {timeout: timeoutSecs/retries * 1000});
      await this.ping();
    } catch (e) {
      await this.restartAdb();
      await this.getConnectedDevices();
      log.errorAndThrow(`Error in waiting for device. Original error: ${e.message}. ` +
                         `Retrying by restarting by ADB`);
    }
  });
};

systemCallMethods.reboot = async function () {
  await this.shell(['stop']);
  await B.delay(2000); // let the emu finish stopping;
  await this.setDeviceProperty('sys.boot_completed', 0);
  await this.shell(['start']);
  await retryInterval(90, 1000, async () => {
    let booted = await this.getDeviceProperty('sys.boot_completed');
    if (booted === '1') {
      return;
    } else {
      log.errorAndthrow('Waiting for reboot this takes time');
    }
  });
};

systemCallMethods.fileExists = async function (remotePath) {
  let files = await this.ls(remotePath);
  return files.length > 0;
};

systemCallMethods.ls = async function (remotePath) {
  let stdout = await this.shell(['ls', remotePath]);
  let lines = stdout.split("\n");
  return lines.map(l => l.trim())
              .filter(Boolean)
              .filter(l => l.indexOf("No such file") === -1);
};

export default systemCallMethods;