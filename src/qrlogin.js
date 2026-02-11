/**
 * QR login for QQ Farm mini program (get login code)
 */

const axios = require('axios');
const qrcode = require('qrcode-terminal');
const { sleep, log, logWarn } = require('./utils');

const ChromeUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const QUA = 'V1_HT5_QDT_0.70.2209190_x64_0_DEV_D';
const FARM_APPID = '1112386029';
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 120000;

function getHeaders() {
    return {
        'qua': QUA,
        'host': 'q.qq.com',
        'accept': 'application/json',
        'content-type': 'application/json',
        'user-agent': ChromeUA,
    };
}

async function requestLoginCode() {
    const response = await axios.get('https://q.qq.com/ide/devtoolAuth/GetLoginCode', {
        headers: getHeaders(),
    });
    const { code, data } = response.data || {};
    if (+code !== 0 || !data || !data.code) {
        throw new Error('GetLoginCode failed');
    }
    return {
        code: data.code,
        url: `https://h5.qzone.qq.com/qqq/code/${data.code}?_proxy=1&from=ide`,
    };
}

async function queryStatus(code) {
    const response = await axios.get(`https://q.qq.com/ide/devtoolAuth/syncScanSateGetTicket?code=${code}`, {
        headers: getHeaders(),
    });

    if (response.status !== 200) {
        return { status: 'Error' };
    }

    const { code: resCode, data } = response.data || {};
    if (+resCode === 0) {
        if (+data.ok !== 1) return { status: 'Wait' };
        return { status: 'OK', ticket: data.ticket, uin: data.uin };
    }
    if (+resCode === -10003) return { status: 'Used' };
    return { status: 'Error', msg: `Code: ${resCode}` };
}

async function getAuthCode(ticket, appid) {
    const response = await axios.post('https://q.qq.com/ide/login', {
        appid,
        ticket,
    }, {
        headers: getHeaders(),
    });

    if (response.status !== 200) return '';
    const { code } = response.data || {};
    return code || '';
}

function renderQr(url) {
    try {
        qrcode.generate(url, { small: true });
    } catch (e) {
        log('QR', `Open this URL to scan: ${url}`);
    }
}

function clearConsole() {
    if (!process.stdout.isTTY) return;
    process.stdout.write('\x1b[2J\x1b[H');
}

async function getFarmCodeByQr(options = {}) {
    const pollInterval = options.pollInterval || DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const appid = options.appid || FARM_APPID;

    log('QR', 'Requesting QR code...');
    const login = await requestLoginCode();

    log('QR', 'Scan with QQ app:');
    renderQr(login.url);

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const status = await queryStatus(login.code);
        if (status.status === 'Wait') {
            await sleep(pollInterval);
            continue;
        }
        if (status.status === 'Used') {
            clearConsole();
            logWarn('QR', 'QR code expired');
            return null;
        }
        if (status.status === 'OK') {
            clearConsole();
            const authCode = await getAuthCode(status.ticket, appid);
            if (!authCode) {
                logWarn('QR', 'Get auth code failed');
                return null;
            }
            return { code: authCode, uin: status.uin || '', ticket: status.ticket };
        }
        clearConsole();
        logWarn('QR', 'Query status error');
        return null;
    }

    clearConsole();
    logWarn('QR', 'QR login timeout');
    return null;
}

module.exports = { getFarmCodeByQr };
