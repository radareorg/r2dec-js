/* 
 * Copyright (C) 2018-2019 elicn
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

module.exports = (function() {
    const Graph = require('js/libcore2/analysis/graph');
    const Cntr = require('js/libcore2/analysis/ir/container');
    const Stmt = require('js/libcore2/analysis/ir/statements');
    const Expr = require('js/libcore2/analysis/ir/expressions');

    /*
    var _collect_defs = function(container, selector) {
        var defs = [];

        container.statements.forEach(function(stmt) {
            stmt.expressions.forEach(function(expr) {
                var operands = expr.operands || [];

                var selected = operands.filter(function(op) {
                    return selector(op) && op.is_def;
                });

                defs = defs.concat(selected);
            });
        });

        return defs;
    };

    function SsaContext(func, selector) {
        this.local_defs = {};

        func.basic_blocks.forEach(function(bb) {
            var container = bb.container;

            this.local_defs[container] = _collect_defs(container, selector);
        }, this);
    }

    function Tagger(func, selector) {

    }
    */

    /**
     * Management object for SSA context.
     * @constructor
     */
    function Context(ssa) {
        this.func = ssa.func;
        this.cfg = ssa.cfg;

        this.count = {};
        this.stack = {};
        this.defs = {};

        var entry_addr = this.func.entry_block.container.address;

        this.uninit = new Cntr.Container(entry_addr, []);
    }

    // intialize 'count' and 'stack' to be used in the renaming process
    Context.prototype.initialize = function(func, selector) {
        var count = {};
        var stack = {};

        func.basic_blocks.forEach(function(bb) {
            bb.container.statements.forEach(function(stmt) {
                stmt.expressions.forEach(function(expr) {
                    expr.iter_operands().forEach(function(op) {
                        if (selector(op)) {
                            var repr = op.repr();

                            count[repr] = 0;
                            stack[repr] = [0];
                        }
                    });
                });
            });
        });

        this.count = count;
        this.stack = stack;
    };

    Context.prototype.add_def = function(v) {
        // string representation of definition, including ssa subscripts
        var key = v.toString();

        if (key in this.defs) {
            console.warn('[!]', key, 'was already defined');
        }

        this.defs[key] = v;
        v.uses = [];
    };

    Context.prototype.add_use = function(u) {
        // string representation of user, including ssa subscripts
        var key = u.toString();

        // every used var is expected to be defined beforehand. if it was not,
        // that is probably an architectural register that is initialized implicitly.
        // in x86 architecture that would be the stack pointer, function arguments, etc.
        if (!(key in this.defs)) {
            // uninitialized variable assigned with index 0
            var lhand = u.clone(['idx']);

            // this is an auto-generated assignment; mark as weak def
            lhand.weak = true;

            // default value: this is merely a placeholder and should be replaced
            var rhand = new Expr.Val(0, u.size);

            // all definitions should appear as assignments
            var assign = new Expr.Assign(lhand, rhand);

            this.uninit.push_stmt(Stmt.make_statement(new Expr.Val(0).value, assign));
            this.add_def(lhand);
        }

        var def = this.defs[key];

        if (u.def !== undefined) {
            console.log('[!] definition for user', u, 'was already assigned');
        }

        u.def = def;
        def.uses.push(u);
    };

    Context.prototype.iterate = function(func) {
        // apply `func` on all defs entries, and collect the keys to eliminate
        var eliminate = Object.keys(this.defs).filter(function(d) {
            return func(this.defs[d]);
        }, this);

        // eliminate collected keys from defs
        eliminate.forEach(function(d) {
            delete this.defs[d];
        }, this);

        return eliminate.length > 0;
    };

    Context.prototype.get_local_defs = function() {
        var local_defs = {};

        for (var d in this.defs) {
            var def = this.defs[d];
            var def_container = def.parent_stmt().parent;

            if (!(def_container in local_defs)) {
                local_defs[def_container] = [];
            }

            local_defs[def_container].push(def);
        }

        return local_defs;
    };

    // TODO: liveness is not calculated from def to use, rather from def to def of the same location.
    function LiveRange(def, use) {
        this.def = def; // definition
        this.use = use; // definition's earliest use (killer) in current cfg path
    }

    // check whether the definition precedes a specified expression in cfg
    LiveRange.prototype.is_defined_by = function(expr) {
        var def_pstmt = this.def.parent_stmt();
        var exp_pstmt = expr.parent_stmt();

        // live ranges are collected recursively along backward cfg walk. for that reason, all
        // definitions defined in another block are guaranteed to precede expr. definition that
        // is defined in the same block, must be checked to be defined earlier
        return (def_pstmt.parent !== exp_pstmt.parent) || def_pstmt.address.lt(exp_pstmt.address);
    };

    // check whether the definition is alive by specified expression
    LiveRange.prototype.is_alive_by = function(expr) {
        if (!this.is_killed()) {
            return true;
        }

        var use_pstmt = this.use.parent_stmt();
        var exp_pstmt = expr.parent_stmt();

        return (use_pstmt.parent !== exp_pstmt.parent) || use_pstmt.address.ge(exp_pstmt.address);
    };

    LiveRange.prototype.is_killed = function() {
        return (this.use !== null);
    };

    Context.prototype.get_live_ranges = function(block, ignore_weak) {
        var local_defs = this.get_local_defs();

        // get definition (if any) that is assigned to the enclosing expression.
        // for example, get `def` for the specified `expr`:
        //      def = Expr(..., Expr(..., Expr(..., expr)))
        var _parent_def = function(expr) {
            for (var p = expr.parent; p instanceof Expr.Expr; p = p.parent) {
                if (p instanceof Expr.Assign) {
                    return p.operands[0];
                }
            }

            return null;
        };

        var _is_weak_use = function(expr) {
            var def = _parent_def(expr);

            return def && (def instanceof Expr.Reg) && (def.weak);
        };

        var _get_block_live_ranges = function(block, live_at_entry) {
            var curr_container = block.container;

            var locals = local_defs[curr_container] || [];

            // sort local definitions by their address, so later definitions appear
            // later on the list
            locals.sort(function(d0, d1) {
                var addr0 = d0.parent_stmt().address;
                var addr1 = d1.parent_stmt().address;

                return addr0.sub(addr1);
            });

            var live = Array.prototype.concat(live_at_entry, locals);

            return live.map(function(def) {
                // keep uses that are in the same block as the definition that they kill, and not weak (in case ignoring weak).
                // weak uses are normally a result of artificial assignemnts generated to represent side effects (e.g. overlapping
                // registers in intel architecture)
                var killing = def.uses.filter(function(use) {
                    var use_container = use.parent_stmt().parent;

                    return (use_container === curr_container) && !(ignore_weak && _is_weak_use(use));
                });

                var earliest = null;

                // find the earliest expression that kills def (if any)
                if (killing.length > 0) {
                    earliest = killing.reduce(function(a, b) {
                        var a_address = a.parent_stmt().address;
                        var b_address = b.parent_stmt().address;

                        return b_address.lt(a_address) ? b : a;
                    }, killing[0]);
                }

                // definition and its earliest user; if no such user (null), it means this
                // definition is still alive
                return new LiveRange(def, earliest);
            });
        };

        var _concat_no_dups = function(arrays) {
            var unique = function(elem, i, arr) {
                return arr.indexOf(elem) === i;
            };

            return Array.prototype.concat.apply([], arrays).filter(unique);
        };

        var visited_blocks = [];

        var _ascend_cfg = function(curr) {
            if (visited_blocks.indexOf(curr) !== (-1)) {
                return [];
            }

            visited_blocks.push(curr);

            // ascend cfg recursively: get predecessors' lives on exit
            var live_at_entry;
            var curr_block = node_to_block(this.func, curr);

            if (curr_block === this.func.entry_block) {
                live_at_entry = this.uninit.statements.map(function(stmt) {
                    return stmt.expressions[0].operands[0];
                });
            } else {
                var live_only = function(rng) {
                    return !rng.is_killed();
                };

                // get definitions that have no killing users, i.e. are still alive
                live_at_entry = _concat_no_dups(this.cfg.predecessors(curr).map(function(pred) {
                    return _ascend_cfg.call(this, pred).filter(live_only).map(function(rng) {
                        return rng.def;
                    });
                }, this));
            }

            return _get_block_live_ranges(curr_block, live_at_entry);
        };

        var live_ranges = _ascend_cfg.call(this, block_to_node(this.cfg, block));

        // <DEBUG>
        // console.log('live ranges for:', block.address.toString(16));
        // live_ranges.forEach(function(rng) {
        //     var s = rng.def.toString();
        //     var info = rng.is_killed() ? 'killed at: ' + rng.use.parent_stmt().address.toString(16) : 'live';
        //
        //     console.log(' ', s + ' '.repeat(32 - s.length), '[', info, ']');
        // });
        // </DEBUG>

        return live_ranges;
    };

    Context.prototype.validate = function() {

        var _is_assignable = function(expr) {
            return (expr instanceof Expr.Reg) || (expr instanceof Expr.Deref) || (expr instanceof Expr.Var);
        };

        var defs = this.defs;

        // console.log('validating ssa context');

        // iterate through all expressions in function:
        // - if a definition: make sure it is registered in context defs
        // - if a use: make sure it is attached to a valid definition, which in turn has it on its uses list
        this.func.basic_blocks.forEach(function(blk) {
            blk.container.statements.forEach(function(stmt) {
                stmt.expressions.forEach(function(expr) {
                    if (expr instanceof Expr.Assign) {
                        var lhand = expr.operands[0];

                        if (!_is_assignable(lhand)) {
                            console.log('[!] assigning to a non-assignable expression:', expr);
                        }
                    }

                    expr.iter_operands().forEach(function(op) {
                        if (_is_assignable(op)) {
                            if (op.is_def) {
                                if (!(op in defs)) {
                                    console.log('[!] missing def for:', op);
                                    console.log('    parent statement:', op.parent_stmt());
                                }
                            } else {
                                if (op.def === undefined) {
                                    console.log('[!] use without an assigned def:', op);
                                    console.log('    parent statement:', op.parent_stmt());
                                } else {
                                    if (op.def.uses.indexOf(op) === (-1)) {
                                        console.log('[!] unregistered use:', op);
                                        console.log('    parent statement:', op.parent_stmt());
                                    }
                                }
                            }
                        }
                    });
                });
            });
        });

        // iterate through all definitions registered in context defs:
        // - make sure there are no orphand definitions (i.e. pruned from function but not from context)
        // - make sure all uses are attached appropriately to their definition
        for (var d in defs) {
            var v = defs[d];

            if (v.parent_stmt() === undefined) {
                console.log('[!] stale def:', v);
            }

            v.uses.forEach(function(u, i) {
                if (!(u.def.equals(v))) {
                    console.log('[!] stale use:', v, '[' + i + ']');
                }
            });
        }
    };

    Context.prototype.toString = function() {
        var _get_stmt_addr = function(expr) {
            var p = expr.parent_stmt();

            return p ? p.address.toString(16) : '?';
        };

        var _maxlen = function(arr) {
            return arr.reduce(function(max, current) {
                return current.length > max ? current.length : max;
            }, 0);
        };

        var _toStringArray = function(arr) {
            return '[' + arr.join(', ') + ']';
        };

        var table = Object.keys(this.defs).map(function(d) {
            var def = this.defs[d];
            var def_loc = _get_stmt_addr(def);              // address of definition
            var use_locs = def.uses.map(_get_stmt_addr);    // list of users addresses

            var emblems = [
                def.is_safe ? '+' : '',
                def.weak ? '-' : ''
            ].join('');

            return {
                name    : d,
                emblems : emblems,
                defined : def_loc,
                used    : use_locs
            };
        }, this);

        var names_maxlen = _maxlen(table.map(function(obj) { return obj.name; })) + 3;
        var addrs_maxlen = _maxlen(table.map(function(obj) { return obj.defined; }));

        var header = ['def-use chains:'];

        var lines = table.map(function(obj) {
            var name = obj.name + obj.emblems;  // definition name
            var defined = obj.defined;          // where defined
            var used = obj.used;                // where used (list)

            return [
                ' ',
                name.padEnd(names_maxlen),
                defined.padStart(addrs_maxlen),
                ':',
                _toStringArray(used)
            ].join(' ');
        });

        return Array.prototype.concat(header, lines).join('\n');
    };

    function SSA(func) {
        this.func = func;
        this.cfg = func.cfg();
        this.dom = new Graph.DominatorTree(this.cfg);
        this.context = new Context(this);
    }

    // iterate all statements in block and collect only defined names
    var _find_local_defs = function(selector, block) {
        var defs = [];

        block.container.statements.forEach(function(stmt) {
            stmt.expressions.forEach(function(expr) {
                expr.iter_operands().forEach(function(op) {
                    if (selector(op) && op.is_def) {
                        // see if op was already defined
                        var idx = defs.findIndex(function(d) {
                            return d.equals_no_idx(op);
                        });

                        // if already defined, remove old def and use the new one instead
                        if (idx !== (-1)) {
                            defs.splice(idx, 1);
                        }

                        defs.push(op);
                    }
                });
            });
        });

        return defs;
    };

    // get a function basic block from a graph node
    var node_to_block = function(f, node) {
        return f.getBlock(node.key) || null;
    };

    // get a graph node from a function basic block
    var block_to_node = function(g, block) {
        return g.getNode(block.address) || null;
    };

    var insert_phi_exprs = function(selector) {
        var defs = {};
        var blocks = this.func.basic_blocks;

        // map a block to its list of definitions
        blocks.forEach(function(blk) {
            defs[blk] = _find_local_defs(selector, blk);
        });

        // JS causes defsites keys to be stored as strings. since we need the definitions
        // expressions themselves, we need to maintain a dedicated array for that.
        var defsites_vals = {};
        var defsites_keys = [];

        // map a variable to blocks where it is defined
        blocks.forEach(function(blk) {
            var block_defs = defs[blk];

            block_defs.forEach(function(d) {
                if (!(d in defsites_vals)) {
                    defsites_keys.push(d);
                    defsites_vals[d] = [];
                }

                defsites_vals[d].push(blk);
            });
        });

        var phis = {};

        for (var a in defsites_keys) {
            a = defsites_keys[a];       // a: definition expression
            var W = defsites_vals[a];   // W: an array of blocks where 'a' is defined

            while (W.length > 0) {
                // defsites value list elements are basic blocks, while domTree accepts nodes
                var n = block_to_node(this.dom, W.pop());

                this.dom.dominanceFrontier(n).forEach(function(y) {
                    if (!(y in phis)) {
                        phis[y] = [];
                    }

                    // if 'a' has no phi statement in current block, create one
                    if (phis[y].indexOf(a) === (-1)) {
                        var args = new Array(this.cfg.predecessors(y).length);

                        // duplicate 'a' as many times as 'y' has predecessors. note that the
                        // ssa index of the cloned expression is preserved, since memory dereferences
                        // may be enclosing indexed expressions
                        for (var i = 0; i < args.length; i++) {
                            args[i] = a.clone(['idx', 'def', 'is_safe', 'weak']);
                        }

                        var phi_var = a.clone(['idx', 'def', 'is_safe']);

                        // phi variables are artificial and may be safely eliminated
                        phi_var.weak = true;

                        // turn Node y into BasicBlock _y
                        var _y = node_to_block(this.func, y);

                        // insert the statement a = Phi(a, a, ..., a) at the top of block y, where the
                        // phi-function has as many arguments as y has predecessors
                        var phi_assignment = new Expr.Assign(phi_var, new Expr.Phi(args));
                        var phi_stmt = Stmt.make_statement(_y.address, phi_assignment);

                        // insert phi at the beginning of the container
                        _y.container.unshift_stmt(phi_stmt);

                        phis[y].push(a);
                        if (defs[_y].indexOf(a) === (-1)) {
                            W.push(_y);
                        }
                    }
                }, this);
            }
        }
    };

    /** @private */
    SSA.prototype._rename = function(selector) {

        // predicate to determine whether an expression is a phi definition
        var is_phi_assignment = function(expr) {
            return (expr instanceof Expr.Assign) && (expr.operands[1] instanceof Expr.Phi);
        };

        // get the top element of an array
        var top = function(arr) {
            return arr[arr.length - 1];
        };

        var rename_rec = function(context, n) {
            n.container.statements.forEach(function(stmt) {
                // pick up uses to assign ssa index
                stmt.expressions.forEach(function(expr) {
                    if (!is_phi_assignment(expr)) {
                        expr.iter_operands(true).forEach(function(op) {
                            if (selector(op) && !op.is_def) {
                                var repr = op.repr();
 
                                // nesting derefs are picked up in stack initialization without inner
                                // subscripts, since subscripts are not assigned yet. here they are
                                // referred after inner subscripts are assigned, so they do not appear
                                // in vars stack. for example:
                                //
                                // nesting derefs such as:
                                //      *(*(ebp₁ + 8)₀ + *(ebp₁ - 4)₁)
                                //
                                // do not appear in the stack, because they were picked up as:
                                //      *(*(ebp₁ + 8) + *(ebp₁ - 4))
                                //
                                // <WORKAROUND>
                                if (!(repr in context.stack)) {
                                    console.warn('[!] ssa: could not find stack for', '"' + repr + '"');
                                    context.stack[repr] = [0];
                                    context.count[repr] = 0;
                                }
                                // </WORKAROUND>

                                op.idx = top(context.stack[repr]);
                                context.add_use(op);
                            }
                        });
                    }
                });

                // pick up definitions to assign ssa index
                stmt.expressions.forEach(function(expr) {
                    expr.iter_operands(true).forEach(function(op) {
                        if (selector(op) && op.is_def) {
                            var repr = op.repr();

                            context.count[repr]++;
                            context.stack[repr].push(context.count[repr]);

                            op.idx = top(context.stack[repr]);
                            context.add_def(op);
                        }
                    });
                });
            });

            this.cfg.successors(block_to_node(this.cfg, n)).forEach(function(Y) {
                var j = this.cfg.predecessors(Y).indexOf(block_to_node(this.cfg, n));

                // iterate over all phi functions in Y
                node_to_block(this.func, Y).container.statements.forEach(function(stmt) {
                    stmt.expressions.forEach(function(expr) {
                        if (is_phi_assignment(expr)) {
                            var v = expr.operands[0];

                            if (selector(v)) {
                                var phi = expr.operands[1];
                                var op = phi.operands[j];

                                op.idx = top(context.stack[op.repr()]);
                                context.add_use(op);
                            }
                        }
                    });
                });
            }, this);

            // descend the dominator tree recursively
            this.dom.successors(block_to_node(this.dom, n)).forEach(function(X) {
                rename_rec.call(this, context, node_to_block(this.func, X));
            }, this);

            // cleanup context stack of current block's definitions
            n.container.statements.forEach(function(stmt) {
                stmt.expressions.forEach(function(expr) {
                    expr.iter_operands(true).forEach(function(op) {
                        if (selector(op) && op.is_def) {
                            context.stack[op.repr()].pop();
                        }
                    });
                });
            });
        };

        var entry_block = node_to_block(this.func, this.dom.getRoot());

        this.context.initialize(this.func, selector);
        insert_phi_exprs.call(this, selector);
        rename_rec.call(this, this.context, entry_block);

        return this.context;
    };

    /** @private */
    SSA.prototype._rename_wrapper = function(selector) {
        var context = this._rename(selector);

        // phi relaxation
        simplify_single_phi(context);
        simplify_self_ref_phi(context);
        propagate_chained_phi(context);

        return context;
    };

    SSA.prototype.rename_regs = function() {
        var select_regs = function(expr) {
            return (expr instanceof Expr.Reg);
        };

        return this._rename_wrapper(select_regs);
    };

    SSA.prototype.rename_derefs = function() {
        var select_derefs = function(expr) {
            return (expr instanceof Expr.Deref);
        };

        return this._rename_wrapper(select_derefs);
    };

    SSA.prototype.rename_vars = function() {
        var select_vars = function(expr) {
            return (expr instanceof Expr.Var);
        };

        return this._rename_wrapper(select_vars);
    };

    // propagate phi groups that have only one item in them.
    // if a phi expression has only one argument, propagate it into defined variable
    //
    // x7 = Phi(x4) --> x7 = x4
    var simplify_single_phi = function(ctx) {
        return ctx.iterate(function(def) {
            var p = def.parent;         // p is Expr.Assign
            var lhand = p.operands[0];  // def
            var rhand = p.operands[1];  // assigned expression

            if ((rhand instanceof Expr.Phi) && (rhand.operands.length === 1)) {
                var phi_arg = rhand.operands[0];

                rhand.replace(phi_arg.pluck());
            }

            // this function always return false because it never plucks the
            // entire assignment, rather it just updates it
            return false;
        });
    };

    // propagate self-referencing phis.
    //
    //   x5 = Phi(x2, x5)  -->  x5 = x2
    var simplify_self_ref_phi = function(ctx) {
        return ctx.iterate(function(def) {
            var p = def.parent;         // p is Expr.Assign
            var lhand = p.operands[0];  // def
            var rhand = p.operands[1];  // assigned expression

            if ((rhand instanceof Expr.Phi) && (rhand.operands.length === 2)) {
                var other = null;

                // check which of the phi operands (if any) equals to the assigned variable
                if (rhand.operands[0].equals(lhand)) {
                    other = rhand.operands[1];
                } else if (rhand.operands[1].equals(lhand)) {
                    other = rhand.operands[0];
                }

                if (other) {
                    rhand.replace(other.pluck());
                }
            }

            // this function always return false because it never plucks the
            // entire assignment, rather it just updates it
            return false;
        });
    };

    // propagate a phi with only one use that happens to be also a phi
    var propagate_chained_phi = function(ctx) {
        return ctx.iterate(function(def) {
            var p = def.parent;         // p is Expr.Assign
            var lhand = p.operands[0];  // def
            var rhand = p.operands[1];  // assigned expression

            if ((rhand instanceof Expr.Phi) && (def.uses.length === 1)) {
                var u = def.uses[0];

                if (u.parent instanceof Expr.Phi) {
                    var target_phi = u.parent;

                    // remove propagted phi as it is going to be replaced with its operands
                    u.pluck(true);

                    for (var i = 0; i < rhand.operands.length; i++) {
                        var o = rhand.operands[i];

                        // propagate phi operands into its phi user, avoiding duplications
                        // TODO: not sure if we can safely discard duplicates or not
                        if (!target_phi.has(o)) {
                            target_phi.push_operand(o.clone(['idx', 'def']));
                        }
                    }

                    // detach propagated phi along of its operands
                    p.pluck(true);

                    return true;
                }
            }

            return false;
        });

    };

    SSA.prototype.preserved_locations = function() {
        /**
         * Recursively trace a definition back to its origin definition.
         * @param {Expr} def Defined expression to trace
         * @returns {Expr} Returns the origin definition, or `undefiend` if
         * origin could not be traced back directly from specified definition
         */
        var _get_origin = function(def) {
            if ((def === undefined) || (def.idx === 0)) {
                return def;
            }

            // def is a lhand of an assignment; get the assigned value
            var rhand = def.parent.operands[1];

            if ((rhand instanceof Expr.Reg) || (rhand instanceof Expr.Deref)) {
                return _get_origin(rhand.def);
            }

            return undefined;
        };

        var candidates = {};
        var local_defs = this.context.get_local_defs();

        this.func.exit_blocks.forEach(function(block) {
            local_defs[block.container].forEach(function(def) {
                if (def.idx !== 0) {
                    var origin = _get_origin(def);

                    if (origin && def.equals_no_idx(origin)) {
                        var key = def.repr();

                        if (!(key in candidates)) {
                            candidates[key] = [def, []];
                        }

                        candidates[key][1].push(origin);
                    }
                }
            });
        });

        var preserved = [];

        for (var c in candidates) {
            var def = candidates[c][0];
            var origins = candidates[c][1];

            var identical = function(o) {
                return o.equals(origins[0]);
            };

            if (origins.every(identical)) {
                preserved.push([def, origins[0]]);
            }
        }

        // <DEBUG>
        // console.log('preserved_locations:');
        // preserved.forEach(function(p) {
        //     console.log(' ', p[1], '->', p[0]);
        // });
        // </DEBUG>

        return this.context.preserved = preserved;
    };

    SSA.prototype.transform_out = function() {
        // TODO: handle phi statements
        // TODO: this should be done by iterating over ssa context, and not function blocks

        this.func.basic_blocks.forEach(function(bb) {
            bb.container.statements.forEach(function(stmt) {
                stmt.expressions.forEach(function(expr) {
                    expr.iter_operands().forEach(function(op) {
                        if (op.idx !== undefined) {
                            op.idx = undefined;
                        }
                    });
                });
            });
        });
    };

    return SSA;
}());