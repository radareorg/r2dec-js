/* 
 * Copyright (C) 2018-2019 pancake, deroad, elicn
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

 // a few polyfills to make life easier; do not remove and keep it first
require('js/libcore2/polyfill');

const Graph = require('js/libcore2/analysis/graph');
const JSONr2 = require('js/libcore2/libs/json64');
const Decoder = require('js/libcore2/frontend/decoder');
const Analyzer = require('js/libcore2/frontend/arch/x86/analyzer'); // TODO: does not belong here
const Resolver = require('js/libcore2/frontend/resolver');
const SSA = require('js/libcore2/analysis/ssa');
const Optimizer = require('js/libcore2/analysis/optimizer');
const Propagator = require('js/libcore2/analysis/propagator');
const Pruner = require('js/libcore2/analysis/pruner');
const ControlFlow = require('js/libcore2/analysis/controlflow');
const CodeGen = require('js/libcore2/backend/codegen');

/**
 * Global data accessible from everywhere.
 * @type {Object}
 */
var Global = {

    /**
     * Pipes a command to r2 and returns its output as a string.
     * @param {...string} args A sequence of command line elements
     * @returns {string} Result string received from r2
     */
    r2cmd: function() {
        var cmdline = Array.prototype.slice.call(arguments).join(' ');

        return r2cmd(cmdline).trimEnd();
    },

    /**
     * Pipes a command to r2 and returns its output as a parsed JSON object.
     * @param {...string} args A sequence of command line elements
     * @returns {*} Result object received from r2, or `undefined` if error has occured
     */
   r2cmdj: function() {
        var cmdline = Array.prototype.slice.call(arguments).join(' ');
        var output = r2cmd(cmdline).trimEnd();

        return output ? JSONr2.parse(output) : undefined;
    }
};

function Function(afij, afbj) {
    this.address = afij.offset;
    this.name = afij.name;

    var vars = Array.prototype.concat(afij.bpvars, afij.spvars, afij.regvars);

    // function arguments
    this.args = vars.filter(function(v) {
        return v && ((v.kind === 'arg') || (v.kind === 'reg'));
    });

    // function locals
    this.vars = vars.filter(function(v) {
        return v && (v.kind === 'var');
    });

    // read and process function's basic blocks
    this.basic_blocks = afbj.map(function(bb) {
        return new BasicBlock(bb);
    });

    var entry_blocks = this.basic_blocks.filter(function(bb) {
        return bb.is_entry;
    });

    // the block that serves as the function head. except of some rare cases, there should be exactly
    // one entry block. in case of multiple entry blocks, the first would be arbitraily selected.
    this.entry_block = entry_blocks[0];

    // multiple function entry blocks means that some nodes [i.e. the nodes on the path originated from
    // the entry block that was not selected] are not reachable from the selected root node. to maintain
    // the connectivity property of the control flow graph, nodes that cannot be reached from the selected
    // entry block, have to be removed.
    //
    // unreachable nodes can be filtered out easily by creating a depth-first spanning tree and preserving
    // only the ones that were picked up by the dfs walk
    if (entry_blocks.length > 1) {
        var cfg = this.cfg();
        var dfs = new Graph.DFSpanningTree(cfg);

        var _node_to_block = function(node) {
            return this.getBlock(node.key);
        };

        this.basic_blocks = dfs.iterNodes().map(_node_to_block, this);
    }

    // a list of blocks that leave the function either by returning or tail-calling another function.
    // there should be at least one item in this list. note that an exit block may be the function entry
    // block as well
    this.exit_blocks = this.basic_blocks.filter(function(bb) {
        return bb.is_exit;
    });

    var va_base = afij.offset.sub(afij.minbound);

    // function's lower and upper bounds
    this.lbound = afij.minbound.add(va_base);
    this.ubound = afij.maxbound.add(va_base);

    // TODO: is there a more elegant way to extract that info?
    this.rettype = afij.signature.split(afij.name, 1)[0].trim() || 'void';
}

/**
 * Retreives a basic block by its address.
 * @param {Long} address Address of desired basic block
 * @returns {BasicBlock} Basic block whose address was specified at `address`,
 * or `undefined` if no basic block with that address exists in function
 */
Function.prototype.getBlock = function(address) {
    return this.basic_blocks.find(function(block) {
        return block.address.eq(address);
    });
};

Function.prototype.cfg = function() {
    var nodes = []; // basic blocks
    var edges = []; // jumping, branching or falling into another basic block

    this.basic_blocks.forEach(function(bb) {
        nodes.push(bb.address);

        if (bb.jump) {
            edges.push([bb.address, bb.jump]);
        }

        if (bb.fail) {
            edges.push([bb.address, bb.fail]);
        }

        if (bb.cases) {
            bb.cases.forEach(function(caddr) {
                edges.push([bb.address, caddr]);
            });
        }
    });

    // set up control flow graph
    return new Graph.Directed(nodes, edges, this.entry_block.address);
};

function BasicBlock(bb) {
    // block starting address
    this.address = bb.addr;

    // is a function starting block
    this.is_entry = bb.inputs.eq(0);

    // is a function ending block
    this.is_exit = bb.outputs.eq(0);

    // 'jump' stands for unconditional jump destination, or conditional 'taken' destination; may be undefined
    // in case the basic block ends with a return statement rather than a goto or branch
    this.jump = bb.jump;

    // 'fail' stands for block fall-through, or conditional 'not-taken' destination; may be undefined in case
    // the basic block ends with an unconditional jump or a return statement
    this.fail = bb.fail;

    // list of switch targets, if a switch has been identified
    this.cases = bb.switch_op && bb.switch_op.cases.map(function(c) { return c.addr; });

    // get instructions list
    this.instructions = Global.r2cmdj('aoj', bb.ninstr, '@', bb.addr);
}

// this is used to hash basic blocks in arrays and enumerable objects
BasicBlock.prototype.toString = function() {
    var repr = [
        this.constructor.name,
        this.address.toString(16)
    ].join(' ');

    return '[' + repr + ']';
};

/**
 * Load an entire r2 evar namespace into a nested JS object for intuitive evars access.
 * For example: 'pdd.out.tabsize' would be accessed as: `conf['pdd']['out']['tabsize']`
 * @param {string} ns r2 namespace to load
 * @returns {Object} A nested JS object whose fields are recursively set to evars
 */
var load_r2_evars = function(ns) {
    var evj = Global.r2cmdj('evj', ns);
    var conf = {};

    evj.forEach(function(vobj) {
        var crumbs = vobj.name.split('.');
        var key = crumbs.pop();
        var val = vobj.type === 'int' ? vobj.value.toInt() : vobj.value;

        var tree = conf;

        for (var i = 0; i < crumbs.length; i++) {
            var c = crumbs[i];

            if (tree[c] === undefined) {
                tree[c] = {};
            }

            tree = tree[c];
        }

        tree[key] = val;
    });

    return conf[ns];
};

/**
 * TODO:
 *   bugfixes:
 *      o orphan 'if' conditions
 *      o propagate based on liveness and interference
 *      o fix ssa out translation
 * 
 *   features:
 *      o let user specify parameters values
 *      o type inference: infere datatypes, show casting and array indexing
 *
 *   design:
 *      o create an entry (uninit) and exit virtual blocks for cfg
 *      o disassembled vs. decompiled function
 *      o separate decoding, ssa, controlflow and codegen stages
 *      o redesign ssa and ssa context
 *      o redesign analyzer
 *
 *   functionality:
 *      o trim empty scopes
 *      o use an 'undefined' literal to cut def-use chain?
 *      o treat mem derefs in fcalls as out parameters?
 */

/**
 * Javascript entrypoint
 * @param {Array.<string>} args Array of command line arguments provided to 'pdd'
 */
function r2dec_main(args) {
    try {
        var iIj = Global.r2cmdj('iIj');

        if (iIj.arch in Decoder.archs) {
            var afij = Global.r2cmdj('afij').pop();
            var afbj = Global.r2cmdj('afbj');

            if (afij && afbj) {
                var config = load_r2_evars('pdd');

                var decoder = new Decoder(iIj);
                var analyzer = new Analyzer(decoder.arch);  // TODO: this is a design workaround!
                var func = new Function(afij, afbj);

                // transform assembly instructions into internal representation
                // this is a prerequisit to ssa-based analysis and optimizations
                func.basic_blocks.forEach(function(bb) {
                    bb.container = decoder.transform_ir(bb.instructions);

                    // perform arch-specific modifications (container)
                    analyzer.transform_step(bb.container);
                });

                // perform arch-specific modifications (whole function)
                analyzer.transform_done(func);

                // <DEBUG>
                // func.basic_blocks.forEach(function(bb) {
                //     console.log(bb.container.toString(), '{');
                //     bb.container.statements.forEach(function(stmt) {
                //         console.log('  ', stmt.toString());
                //     });
                //     console.log('}');
                // });
                // </DEBUG>

                var ssa = new SSA(func);
                var ssa_ctx;

                // ssa tagging for registers
                ssa_ctx = ssa.rename_regs();
                analyzer.ssa_step_regs(func, ssa_ctx);

                Optimizer.run([
                    Propagator.propagate_safe_defs
                ], ssa_ctx, config['opt']);

                // ssa tagging for local variables
                ssa_ctx = ssa.rename_vars();
                analyzer.ssa_step_vars(func, ssa_ctx);

                Optimizer.run([
                    Propagator.propagate_safe_defs
                ], ssa_ctx, config['opt']);

                // ssa tagging for memory dereferences
                ssa_ctx = ssa.rename_derefs();
                analyzer.ssa_step_derefs(func, ssa_ctx);

                analyzer.ssa_done(func, ssa);

                Optimizer.run([
                    Propagator.propagate_safe_defs,
                    Pruner.eliminate_dead_regs,
                    Pruner.eliminate_dead_derefs,
                    Pruner.eliminate_dead_results,
                    Pruner.eliminate_def_single_phi,
                    Pruner.eliminate_def_single_phi_circ,
                    Pruner.eliminate_circular_phi
                ], ssa_ctx, config['opt']);

                // <DEBUG desc="emit def-use chains before ssa is transformed out">
                // console.log(ssa_ctx.toString());
                // </DEBUG>

                ssa.validate(ssa_ctx);
                // ssa.transform_out(ssa_ctx);

                var cflow = new ControlFlow(func);
                cflow.fallthroughs();
                cflow.loops();
                cflow.conditions();

                var resolver = new Resolver();
                var codegen = new CodeGen(resolver, config['out']);

                console.log(codegen.emit_func(func));
            } else {
                console.log('error: no data available; analyze the function / binary first');
            }
        } else {
            console.log('unsupported architecture "' + iIj.arch + '"');
        }
    } catch (e) {
        console.log('\ndecompiler has crashed ¯\\_(ツ)_/¯');
        console.log('exception:', e.stack);
    }
}