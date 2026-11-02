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

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LOADER = path.resolve(__dirname, '../../../../bin/templates/platform_www/cdv-electron-crypt.js');
const KEY = 'k'.repeat(32);
const IV = 'i'.repeat(16);

function encrypt (text) {
    const cipher = crypto.createCipheriv('aes-256-cbc', KEY, IV);
    return cipher.update(text, 'utf8', 'base64') + cipher.final('base64');
}

function loaderWithKeys (dir) {
    const file = path.join(dir, 'cdv-electron-crypt.js');
    const source = fs.readFileSync(LOADER, 'utf8')
        .replace(/CRYPT_KEY = '.*';/, `CRYPT_KEY = '${KEY}';`)
        .replace(/CRYPT_IV = '.*';/, `CRYPT_IV = '${IV}';`)
        .replace(/INCLUDE_FILES = \[.*\];/, 'INCLUDE_FILES = ["\\\\.(htm|html|js|css)$"];')
        .replace(/EXCLUDE_FILES = \[.*\];/, 'EXCLUDE_FILES = ["^/cdv-electron-[^/]*\\\\.js$", "^/node_modules/"];');
    fs.writeFileSync(file, source);
    return require(file);
}

describe('cdv-electron-crypt', () => {
    let appRoot;
    let passedThrough;
    let handler;

    const urlOf = rel => pathToFileURL(path.join(appRoot, rel)).href;
    const passThrough = request => {
        passedThrough.push(request.url);
        return new Response('passed through');
    };

    beforeEach(() => {
        appRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cdv-crypt-')));
        passedThrough = [];
        fs.mkdirSync(path.join(appRoot, 'templates'));
        fs.writeFileSync(path.join(appRoot, 'index.html'), encrypt('<html>héllo</html>'));
        fs.writeFileSync(path.join(appRoot, 'app.js'), encrypt('var a = "ünï";'));
        fs.writeFileSync(path.join(appRoot, 'a b.css'), encrypt('a{}'));
        fs.writeFileSync(path.join(appRoot, 'broken.js'), 'not ciphertext');
        handler = loaderWithKeys(appRoot).createFileHandler(appRoot, passThrough);
    });

    afterEach(() => {
        fs.rmSync(appRoot, { recursive: true, force: true });
    });

    it('serves encrypted html and js as plaintext with the right type', async () => {
        const html = await handler({ url: urlOf('index.html') });
        expect(await html.text()).toBe('<html>héllo</html>');
        expect(html.headers.get('content-type')).toBe('text/html');

        const js = await handler({ url: urlOf('app.js') });
        expect(await js.text()).toBe('var a = "ünï";');
        expect(js.headers.get('content-type')).toBe('text/javascript');
    });

    it('ignores the query and hash and decodes escapes in the url', async () => {
        const css = await handler({ url: `${urlOf('a b.css')}?v=1#x` });
        expect(await css.text()).toBe('a{}');
    });

    it('passes through what was never encrypted', async () => {
        await handler({ url: urlOf('img/logo.png') });
        await handler({ url: urlOf('cdv-electron-main.js') });
        await handler({ url: urlOf('node_modules/svc/index.js') });
        expect(passedThrough.length).toBe(3);
    });

    it('passes through files outside the app, including a traversal', async () => {
        await handler({ url: pathToFileURL(path.join(os.tmpdir(), 'outside.js')).href });
        await handler({ url: `${pathToFileURL(appRoot).href}/../outside.js` });
        expect(passedThrough.length).toBe(2);
    });

    it('passes through a matching file that does not exist', async () => {
        await handler({ url: urlOf('missing.js') });
        expect(passedThrough.length).toBe(1);
    });

    it('answers 500 rather than serving a file it cannot decrypt', async () => {
        const logged = spyOn(console, 'error');
        const response = await handler({ url: urlOf('broken.js') });
        expect(response.status).toBe(500);
        expect(await response.text()).toBe('');
        expect(logged).toHaveBeenCalled();
    });

    it('registers a file handler only once the hook has written a key', () => {
        const handled = [];
        const protocol = { handle: scheme => handled.push(scheme) };

        expect(require(LOADER).register(protocol, {}, appRoot)).toBe(false);
        expect(handled).toEqual([]);

        expect(loaderWithKeys(appRoot).register(protocol, {}, appRoot)).toBe(true);
        expect(handled).toEqual(['file']);
    });
});
