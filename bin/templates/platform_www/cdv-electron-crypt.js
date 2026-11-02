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
const path = require('node:path');
const { fileURLToPath } = require('node:url');

// Written by cordova-plugin-crypt-file's after_prepare hook. Empty means the
// plugin is not installed: nothing is encrypted and no handler is registered.
const CRYPT_KEY = '';
const CRYPT_IV = '';
const INCLUDE_FILES = [];
const EXCLUDE_FILES = [];

const MIME_TYPES = {
    '.css': 'text/css',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.js': 'text/javascript'
};

function matchesAny (patterns, relPath) {
    return patterns.some(pattern => new RegExp(pattern).test(relPath));
}

function isCryptFile (relPath) {
    return matchesAny(INCLUDE_FILES, relPath) && !matchesAny(EXCLUDE_FILES, relPath);
}

function decrypt (base64Bytes) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', CRYPT_KEY, CRYPT_IV);
    return Buffer.concat([decipher.update(base64Bytes.toString('latin1'), 'base64'), decipher.final()]);
}

/** The request's path inside the app as `/js/a.js`, or null when it is outside the app. */
function appRelativePath (requestUrl, appRoot) {
    let filePath;
    try {
        filePath = fileURLToPath(requestUrl);
    } catch (err) {
        return null;
    }
    const relPath = path.relative(appRoot, filePath);
    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
        return null;
    }
    return `/${relPath.split(path.sep).join('/')}`;
}

/**
 * Serves encrypted app files as plaintext at their own file:// URL, so the page
 * keeps its origin and with it every IndexedDB and localStorage already on disk.
 */
function createFileHandler (appRoot, passThrough) {
    return async request => {
        const relPath = appRelativePath(request.url, appRoot);
        if (!relPath || !isCryptFile(relPath)) {
            return passThrough(request);
        }

        let encrypted;
        try {
            encrypted = await fs.promises.readFile(path.join(appRoot, relPath));
        } catch (err) {
            return passThrough(request);
        }

        try {
            const contentType = MIME_TYPES[path.extname(relPath).toLowerCase()];
            return new Response(decrypt(encrypted), {
                status: 200,
                headers: contentType ? { 'content-type': contentType } : {}
            });
        } catch (err) {
            console.error(`[cdv-electron-crypt] Unable to decrypt ${relPath}: ${err.message}`);
            return new Response('', { status: 500 });
        }
    };
}

/** Must run once, after the app is ready and before the first window loads. */
function register (protocol, net, appRoot) {
    if (!CRYPT_KEY) {
        return false;
    }
    const passThrough = request => net.fetch(request, { bypassCustomProtocolHandlers: true });
    protocol.handle('file', createFileHandler(appRoot, passThrough));
    return true;
}

module.exports = { createFileHandler, register };
