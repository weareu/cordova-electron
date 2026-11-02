/*
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const PLATFORM_WWW = path.resolve(__dirname, '../../../../bin/templates/platform_www');

const PLUGIN = `
module.exports = {
    echo: (args) => Promise.resolve(args),
    plain: () => 'not a promise',
    code: () => Promise.reject(5),
    zero: () => Promise.reject(0),
    rejected: () => Promise.reject(new Error('rejected')),
    thrown: () => { throw new TypeError('thrown'); }
};`;

describe('plugin exec between page and main process', () => {
    let dir;
    let realLoad;
    let page;

    function call (service, action, args) {
        return new Promise((resolve) => {
            page.exec(
                (result) => resolve({ success: result }),
                (error) => resolve({ error }),
                service, action, args
            );
        });
    }

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdv-exec-'));
        ['cdv-electron-main.js', 'cdv-electron-preload.js', 'cdv-electron-crypt.js'].forEach((name) => {
            fs.copyFileSync(path.join(PLATFORM_WWW, name), path.join(dir, name));
        });
        fs.writeFileSync(path.join(dir, 'good.js'), PLUGIN);
        fs.writeFileSync(path.join(dir, 'broken.js'), 'global.require("electron");');
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
            cordova: { services: { Good: path.join(dir, 'good.js'), Broken: path.join(dir, 'broken.js') } }
        }));
        fs.writeFileSync(path.join(dir, 'cdv-electron-settings.json'), JSON.stringify({
            browserWindow: { webPreferences: {} }, scheme: 'file', hostname: 'localhost'
        }));
        fs.writeFileSync(path.join(dir, 'cdv-reserved-scheme.json'), '[]');

        let handler;
        const fakeElectron = {
            app: { on: () => {}, getAppPath: () => dir },
            BrowserWindow: function () {},
            protocol: {},
            net: {},
            ipcMain: { handle: (_, fn) => { handler = fn; } },
            ipcRenderer: { invoke: (_, ...args) => handler({}, ...args) },
            contextBridge: { exposeInMainWorld: (_, api) => { page = api; } }
        };
        realLoad = Module._load;
        Module._load = function (request) {
            return request === 'electron' ? fakeElectron : realLoad.apply(this, arguments);
        };
        require(path.join(dir, 'cdv-electron-main.js'));
        require(path.join(dir, 'cdv-electron-preload.js'));
    });

    afterEach(() => {
        Module._load = realLoad;
        Object.keys(require.cache).filter((file) => file.startsWith(dir)).forEach((file) => {
            delete require.cache[file];
        });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('hands the plugin one array of arguments and returns its result', async () => {
        expect(await call('Good', 'echo', ['a', 2])).toEqual({ success: ['a', 2] });
    });

    it('accepts a plugin that returns a plain value', async () => {
        expect(await call('Good', 'plain', [])).toEqual({ success: 'not a promise' });
    });

    it('keeps a numeric error code, including zero', async () => {
        expect(await call('Good', 'code', [])).toEqual({ error: 5 });
        expect(await call('Good', 'zero', [])).toEqual({ error: 0 });
    });

    it('fails with the error of a rejected or throwing plugin', async () => {
        expect((await call('Good', 'rejected', [])).error.message).toBe('rejected');
        expect((await call('Good', 'thrown', [])).error.message).toBe('thrown');
    });

    it('calls the error callback for an unknown action, service or a plugin that cannot load', async () => {
        expect((await call('Good', 'none', [])).error.message).toContain('"none"');
        expect((await call('Nope', 'none', [])).error.message).toContain('"Nope"');
        expect((await call('Broken', 'any', [])).error.message).toContain('global.require');
    });

    it('does not fail without callbacks', async () => {
        await page.exec(undefined, undefined, 'Good', 'echo', []);
        await page.exec(undefined, undefined, 'Good', 'code', []);
    });
});
