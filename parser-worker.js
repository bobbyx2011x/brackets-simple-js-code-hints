/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50, regexp: true */
/*global self, importScripts, esprima, setTimeout */

/**
 * Loads a file that contains an AMD module definition using the web worker
 * importScripts global function.
 *
 * @param {String} url - The URL of the module to load
 */
function require(url) {
    "use strict";

    var exports = {};

    /*
     * The following function is called by AMD modules when loaded with
     * importScripts. CommonJS-style modules will only pass a wrapper function
     * as a single argument; proper AMD-style modules may additionally pass an
     * array of bindings, which are ignored. In the former case, the wrapper
     * function expects require, exports and module arguments; in the latter
     * case, the wrapper function expects only an exports arguments.
     */
    self.define = function (bindings, wrapper) {
        var module = { exports: exports },
            require = null;

        if (typeof bindings === "function") {
            wrapper = bindings;
        } else {
            require = module.exports;
        }

        wrapper(require, module.exports, module);
        exports = module.exports;
    };
    self.define.amd = true;
    importScripts(url);
    return exports;
}

(function () {
    "use strict";

    var Scope       = require("Scope.js"),
        HintUtils   = require('HintUtils.js'),
        esprima     = require('esprima/esprima.js');

    var MAX_RETRIES = 100;

    function _log(msg) {
        self.postMessage({log: msg });
    }

    /**
     * Walk the scope to find all the objects of a given type, along with a
     * list of their positions in the file.
     */
    function siftPositions(scope, walk, keyProp) {
        var occurrences,
            results = [],
            key,
            token,
            comparator = function (a, b) { return a - b; };

        occurrences = walk.call(scope, function (acc, token) {
            if (Object.prototype.hasOwnProperty.call(acc, token[keyProp])) {
                acc[token[keyProp]].push(token.range[0]);
            } else {
                acc[token[keyProp]] = [token.range[0]];
            }
            return acc;
        }, {});

        for (key in occurrences) {
            if (Object.prototype.hasOwnProperty.call(occurrences, key)) {
                token = HintUtils.makeToken(key, occurrences[key].sort(comparator));
                results.push(token);
            }
        }
        return results;
    }

    /**
     * Walk the scope to compute all available association objects
     */
    function siftAssociations(scope) {
        return scope.walkDownAssociations(function (acc, assoc) {
            var obj     = assoc.object,
                prop    = assoc.property;
            
            if (Object.prototype.hasOwnProperty.call(acc, obj.name)) {
                if (Object.prototype.hasOwnProperty.call(acc[obj.name], prop.name)) {
                    acc[obj.name][prop.name]++;
                } else {
                    acc[obj.name][prop.name] = 1;
                }
            } else {
                acc[obj.name] = {};
                acc[obj.name][prop.name] = 1;
            }
            return acc;
        }, {});
    }

    /**
     * Look for a JSLint globals annotation in the comments
     */
    function extractGlobals(comments) {
        var globals = [];

        if (comments) {
            comments.forEach(function (c) {
                if (c.type === "Block") {
                    if (c.value) {
                        if (c.value.indexOf("global") === 0) {
                            c.value.substring(7).split(",").forEach(function (g) {
                                var index = g.indexOf(":");

                                if (index >= 0) {
                                    g = g.substring(0, index);
                                }
                                globals.push(HintUtils.makeToken(g.trim()));
                            });
                        } else if (c.value.indexOf("jslint") === 0) {
                            c.value.substring(7).split(",").forEach(function (e) {
                                var index = e.indexOf(":"),
                                    prop = (index >= 0) ? e.substring(0, index).trim() : "",
                                    val = (index >= 0) ? e.substring(index + 1, e.length).trim() : "";

                                if (val === "true" && HintUtils.JSL_GLOBAL_DEFS.hasOwnProperty(prop)) {
                                    globals = globals.concat(HintUtils.JSL_GLOBAL_DEFS[prop]);
                                }
                            });
                        }
                    }
                    
                }
            });
        }

        globals.sort(function (a, b) { return a.value < b.value; });
        return globals;
    }

    function respond(dir, file, length, parseObj) {
        var scope           = parseObj ? parseObj.scope : [],
            globals         = parseObj ? parseObj.globals : [],
            identifiers     = parseObj ? siftPositions(scope, scope.walkDownIdentifiers, "name") : [],
            properties      = parseObj ? siftPositions(scope, scope.walkDownProperties, "name") : [],
            literals        = parseObj ? siftPositions(scope, scope.walkDownLiterals, "value") : [],
            associations    = parseObj ? siftAssociations(scope, scope.walkDownAssociations) : [],
            response        = {
                type            : HintUtils.SCOPE_MSG_TYPE,
                dir             : dir,
                file            : file,
                length          : length,
                scope           : scope,
                globals         : HintUtils.annotateGlobals(globals),
                identifiers     : identifiers,
                properties      : HintUtils.annotateWithPath(properties, dir, file),
                literals        : HintUtils.annotateLiterals(literals, "string"),
                associations    : associations,
                success         : !!parseObj
            };

        self.postMessage(response);
    }

    /**
     * Use Esprima to parse a JavaScript text
     */
    function parse(dir, file, text, retries) {
        try {
            var ast = esprima.parse(text, {
                range       : true,
                tolerant    : true,
                comment     : true
            });

            if (ast.errors.length > 0) {
                _log("Parse errors: " + JSON.stringify(ast.errors));
            }

            respond(dir, file, text.length, {
                scope : new Scope(ast),
                globals : extractGlobals(ast.comments)
            });
        } catch (err) {
            // If parsing fails, we can try again after blanking out the line
            // that caused the parse error. This is unreliable though, because
            // the line number on which the parser fails is not necessarily the
            // best line to remove. Some errors will cause the entire remainder
            // of the file to be blanked out, never resulting in a parseable
            // file. Consequently, this is attempted only when necessary; i.e.,
            // when the request.force flag is set. 
            // Inspired by fuckit.js: https://github.com/mattdiamond/fuckitjs

            // _log("Parsing failed: " + err + " at " + err.index);
            if (retries > 0) {
                var lines = text.split("\n"),
                    lineno = Math.min(lines.length, err.lineNumber) - 1,
                    newline,
                    removed;

                // Blank the offending line and start over
                if (-1 < lineno < lines.length) {
                    newline = lines[lineno].replace(/./g, " ");
                    if (newline !== lines[lineno]) {
                        removed = lines.splice(lineno, 1, newline);
                        if (removed && removed.length > 0) {
                            setTimeout(function () {
                                parse(dir, file, text.length, lines.join("\n"), --retries);
                            }, 0);
                            return;
                        }
                    }
                }
            }
            respond(dir, file, text.length, null);
        }
    }
    
    self.addEventListener("message", function (e) {
        var request = e.data,
            type = request.type;

        if (type === HintUtils.SCOPE_MSG_TYPE) {
            var dir     = request.dir,
                file    = request.file,
                text    = request.text,
                retries = request.force ? MAX_RETRIES : 0;
            setTimeout(function () { parse(dir, file, text, retries); }, 0);
        } else {
            _log("Unknown message: " + JSON.stringify(request));
        }
    });
}());
