/* 
 * Copyright (C) 2019 elicn
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

(function() {
    const Expr = require('js/libcore2/analysis/ir/expressions');

    /**
     * @callback Selector
     * @param {Expr} def Defined expression instance
     * @param {Expr} val Expression assigned to definition
     * @param {*} conf Configuration object
     * @returns {boolean} Returns `true` if specified `def` and `val` are
     * OK to be selected for pruning
     */

    /**
     * Pruning pass base class.
     * @param {Selector} selector Function to determine which definitions should
     * be considered for pruning. May contain side-effects.
     */
    function Pruner(selector) {
        this.selector = selector;
    }

    Pruner.prototype.run = function(context, config) {
        var pruned = [];

        for (var d in context.defs) {
            var p = context.defs[d].parent; // parent assignment
            var def = p.operands[0];        // defined variable
            var val = p.operands[1];        // assigned expression

            if (this.selector(def, val, config)) {
                p.pluck(true);

                pruned.push(d);
            }
        }

        pruned.forEach(function(d) {
            delete context.defs[d];
        });

        return pruned.length > 0;
    };

    // --------------------------------------------------

    // eliminate dead assignments to registers
    var _select_dead_regs = function(def, val, conf) {
        // elinimate dead assignments to reg, however:
        // - return value regs assigned to fcalls cannot be eliminated, as fcalls may have side effects
        // - assigned variables, even though not used, better stay there for clarity
        // - however, if either of these exceptions was a def that was fully propagated, then prune
        return (def.uses.length === 0)
            && (def instanceof Expr.Reg) && !(def instanceof Expr.Var)
            && (!(val instanceof Expr.Call) || (def.prune));
    };

    // eliminate dead assignments to memory
    var _select_dead_derefs = function(def, val, conf) {
        // return `true` if `expr` is a user
        var _is_user = function(expr) {
            return (expr.def !== undefined) && (expr.def.uses.length > 0);
        };

        if (def.uses.length === 0) {
            if ((def instanceof Expr.Deref) && ((val instanceof Expr.Phi) || conf.noalias || def.is_safe)) {
                var memloc = def.operands[0];

                // in case the dereferenced memory location is calculated based on a used variable,
                // it is probably an aliased pointer. make sure this is not the case
                return (!(memloc.iter_operands().some(_is_user)) || def.is_safe);
            }
        }

        return false;
    };

    var _select_dead_results = function(def, val, conf) {
        if (def.uses.length === 0) {
            // function calls may have side effects and cannot be eliminated altogether.
            // instead, they are extracted from the assignment and kept as standalone exprs
            if ((def instanceof Expr.Reg) && (val instanceof Expr.Call)) {
                var p = def.parent;
                var stmt = p.parent;
                var fcall = val.pluck();

                stmt.push_expr_after(fcall, p);

                return true;
            }
        }

        return false;
    };

    // eliminate a variable that has only one use, which is a phi assignment to self
    // e.g. x₂ has only one use, and: x₂ = Φ(..., x₂, ...)
    var _select_def_single_phi = function(def, val, conf) {
        if (def.uses.length === 1) {
            var u = def.uses[0];

            // the only use is a phi arg, which assigned to self
            return (u.parent instanceof Expr.Phi) && (u.parent.equals(val));
        }

        return false;
    };

    // eliniminate a variable that has only one use, which is a phi that ends up assigned to self.
    // e.g. x₃ has only one use, which is a phi arg in a phi that is assigned to x₂:
    //
    //   x₂ = Φ(..., x₃, ...)
    //   ...
    //   x₃ = x₂
    var _select_def_single_phi_circ = function(def, val, conf) {
        if (def.uses.length === 1) {
            var u = def.uses[0];

            // the only use is a phi arg, which assigned to a circular def
            return (u.parent instanceof Expr.Phi) && (u.parent.parent.operands[0].equals(val));
        }
    };

    // eliniminate a variable that is assigned a circular phi.
    // e.g. all x₂ users are phi expressions that are assigned to definitions that in turn assigned
    // circular phi expressions.
    //
    //   x₂ = Φ(..., x₃, ...)
    //   ...
    //   x₃ = Φ(..., x₄, ...)
    //   ...
    //   x₄ = Φ(..., x₂, ...)
    var _select_circular_phi = function(def, val, conf) {
        var visited = [];

        var __is_circular_phi = function(_val) {
            if (_val instanceof Expr.Phi) {
                // lhand of the phi assignment
                var _def = _val.parent.operands[0];

                if (visited.indexOf(_def) === (-1)) {
                    visited.push(_def);

                    return _def.uses.every(function(u) {
                        return __is_circular_phi(u.parent);
                    });
                }

                // a visited phi: it's a circle
                return true;
            }

            // not a phi
            return false;
        };

        return __is_circular_phi(val);
    };

    // --------------------------------------------------

    Pruner.eliminate_dead_regs           = new Pruner(_select_dead_regs);
    Pruner.eliminate_dead_derefs         = new Pruner(_select_dead_derefs);
    Pruner.eliminate_dead_results        = new Pruner(_select_dead_results);
    Pruner.eliminate_def_single_phi      = new Pruner(_select_def_single_phi);
    Pruner.eliminate_def_single_phi_circ = new Pruner(_select_def_single_phi_circ);
    Pruner.eliminate_circular_phi        = new Pruner(_select_circular_phi);

    return Pruner;
});