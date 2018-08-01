/* 
 * Copyright (c) 2017-2018, pancake <pancake@nopcode.org>, Giovanni Dante Grazioli <deroad@libero.it>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

Duktape.errCreate = function(err) {
    try {
        if (typeof err === 'object') {
            var p = {
                message: '' + err.message,
                stack: '' + err.stack,
                lineNumber: '' + err.lineNumber
            };
            return p;
        }
    } catch (e) {}
    return err;
};

var libdec = require('libdec/libdec');
var padding = '            ';
var usages = {
    "--help": "this help message",
    "--colors": "enables syntax colors",
    "--assembly": "shows pseudo next to the assembly",
    "--offset": "shows pseudo next to the offset",
    "--casts": "shows all casts in the pseudo code",
    "--issue": "generates the json used for the test suite",
    "--debug": "do not catch exceptions",
    "--html": "outputs html data instead of text",
    "--xrefs": "shows all xrefs in the pseudo code",
}

function has_option(args, name) {
    return (args.indexOf(name) >= 0);
}

function has_invalid_args(args) {
    for (var i = 0; i < args.length; i++) {
        if (args[i] != '' && !usages[args[i]]) {
            console.log('Invalid argument \'' + args[i] + '\'\n');
            return true;
        }
    }
    return false;
}

function usage() {
    console.log("r2dec [options]");
    for (var key in usages) {
        var cmd = key + padding.substr(key.length, padding.length);
        console.log("       " + cmd + " | " + usages[key]);
    }
}

function r2cmdj(m, empty) {
    var x = r2cmd(m).trim();
    return x.length > 0 ? libdec.JSON.parse(x.replace(/\n/g, '')) : empty;
}

function r2dec_main(args) {
    if (has_invalid_args(args)) {
        args.push('--help');
    }
    if (has_option(args, '--help')) {
        usage();
        return;
    }
    try {
        var arch = r2cmd('e asm.arch').trim();
        var bits = r2cmd('e asm.bits').trim();
        var honorpseudo = r2cmd('e asm.pseudo').trim() == 'true';
        var honorcast = r2cmd('e r2dec.casts').trim() == 'true';
        var honorasm = r2cmd('e r2dec.asm').trim() == 'true';
        var honoroffset = r2cmd('e r2dec.offset').trim() == 'true';
        var honorxrefs = r2cmd('e r2dec.xrefs').trim() == 'true';
        var honorhtml = r2cmd('e scr.html').trim() == 'true';
        var honorcolor = parseInt(r2cmd('e scr.color').trim()) > 0;

        // r2dec options
        var options = {
            theme: r2cmd('e r2dec.theme').trim(),
            color: (honorcolor || has_option(args, '--colors')),
            casts: (honorcast || has_option(args, '--casts')),
            xrefs: (honorxrefs || has_option(args, '--xrefs')),
            assembly: (honorasm || has_option(args, '--assembly')),
            offset: (honoroffset || has_option(args, '--offset')),
            html: (honorhtml || has_option(args, '--html')),
            ident: null
        };

        var architecture = libdec.archs[arch];

        if (architecture) {
            // af seems to break renaming.
            /* asm.pseudo breaks things.. */
            if (honorpseudo) {
                r2cmd('e asm.pseudo = false');
            }

            if (has_option(args, '--issue')) {
                var xrefs = (r2cmd('isj')).trim();
                var strings = (r2cmd('izj')).trim();
                var functions = (r2cmd('aflj')).trim();
                var data = (r2cmd('agj')).trim();
                var fcnargs = (r2cmd('afvj').replace(/\n/g, '')).trim();
                var archbits = (r2cmd('e asm.bits')).trim();
                if (xrefs.length == 0) {
                    xrefs = '[]';
                }
                if (strings.length == 0) {
                    strings = '[]';
                }
                if (functions.length == 0) {
                    functions = '[]';
                }
                if (data.length == 0) {
                    data = '[]';
                }
                if (fcnargs.length == 0) {
                    fcnargs = '{"sp":[],"bp":[],"reg":[]}';
                }
                if (archbits.length == 0) {
                    archbits = '32';
                }
                console.log('{"name":"issue_' + (new Date()).getTime() +
                    '","arch":"' + arch +
                    '","archbits":' + archbits +
                    ',"agj":' + data +
                    ',"isj":' + xrefs +
                    ',"izj":' + strings +
                    ',"afvj":' + fcnargs +
                    ',"aflj":' + functions + '}');
            } else {
                var xrefs = r2cmdj('isj', []);
                var strings = r2cmdj('izj', []);
                var functions = r2cmdj('aflj', []);
                var data = r2cmdj('agj', []);
                var archbits = parseInt((r2cmd('e asm.bits')).trim());
                var fcnargs = r2cmdj('afvj', {
                    "sp": [],
                    "bp": [],
                    "reg": []
                });
                if (data && data.length > 0) {
                    var routine = libdec.analyzer.make(data);
                    libdec.analyzer.setOptions(options);
                    libdec.analyzer.strings(routine, strings);
                    libdec.analyzer.functions(routine, functions);
                    libdec.analyzer.analyze(routine, architecture, archbits, fcnargs);
                    libdec.analyzer.xrefs(routine, xrefs);
                    routine.print(console.log, options);
                } else {
                    console.log('Error: no data available.\nPlease analyze the function/binary first.');
                }
            }

            if (honorpseudo) {
                r2cmd('e asm.pseudo = true');
            }
        } else {
            console.log(arch + ' is not currently supported.\n' +
                'Please open an enhancement issue at https://github.com/wargio/r2dec-js/issues');
            libdec.supported();
        }
    } catch (e) {
        if (has_option(args, '--debug')) {
            console.log('Exception:', e.stack);
        } else {
            console.log(
                '\n\nr2dec has crashed.\n' +
                'Please report the bug at https://github.com/wargio/r2dec-js/issues\n' +
                'Use the option \'--issue\' or the command \'pddi\' to generate \n' +
                'the needed data for the issue.'
            );
        }
    }
}