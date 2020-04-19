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

(function() {
    const Long = require('js/libcore2/libs/long');
    const Expr = require('js/libcore2/analysis/ir/expressions');

    // list of ssa properties to preserve when cloning an expression
    const wssa = ['idx', 'def'];

    // this list is ordered in a way that two relations indexes may be combined
    // together using bitwise operations, and produce the appropriate relation
    // as a result.
    //
    // for eample: (x EQ y) || (x LT y) would produce (x LE y) because 0b001 | 0b010 == 0b011
    // that works for combining relations using bitwise and, or and not
    /** @type {Array<string>} */
    const __rel_names = [
        null,   /* palceholder for False */ // 0b000
        Expr.EQ.prototype.constructor.name, // 0b001
        Expr.LT.prototype.constructor.name, // 0b010
        Expr.LE.prototype.constructor.name, // 0b011
        Expr.GT.prototype.constructor.name, // 0b100
        Expr.GE.prototype.constructor.name, // 0b101
        Expr.NE.prototype.constructor.name, // 0b110
        null,   /* palceholder for True */  // 0b111
    ];

    /**
     * A list of closures, each of which generates a relation that corresponds to its index (rank)
     * @type {Array<function>}
     * @inner
     */
    const __rel_exprs = [
        function() { return new Expr.Val(0, 1); },
        function(x, y) { return new Expr.EQ(x, y); },
        function(x, y) { return new Expr.LT(x, y); },
        function(x, y) { return new Expr.LE(x, y); },
        function(x, y) { return new Expr.GT(x, y); },
        function(x, y) { return new Expr.GE(x, y); },
        function(x, y) { return new Expr.NE(x, y); },
        function() { return new Expr.Val(1, 1); }
    ];

    /**
     * Translates a relation rank into its corresponding expression.
     * Instead of returning a new expression, a closure is returned to
     * construct it
     * @param {number} rank Rank of selected relation
     * @returns {function} Construction closure 
     * @inner
     */
    var __get_rel_expr = function(rank) {
        return __rel_exprs[rank];
    };

    /**
     * Returns the ranking value of a given relation (comparison) expression
     * instance
     * @param {Expr.Expr} expr Relation expression instance
     * @returns {number} A numberic value between 0 and 7, or -1 if not a valid relation instance
     * @inner
     */
    var __get_rel_rank = function(expr) {
        return expr ? __rel_names.indexOf(expr.constructor.name) : (-1);
    };

    /**
     * Returns the opposite ranking value of a given rank
     * @param {number} rank Rank to negate
     * @returns {number} A numberic value between 0 and 7, which represents the negation of given one
     * @inner
     */
    var __get_neg_rank = function(rank) {
        return rank ^ (__rel_exprs.length - 1);
    };

    /**
     * Checks whether an expression is an instance of a comparison expression
     * @param {Expr.Expr} expr An expression instance to check
     * @returns `true` if `expr` is an instance of a comparison expression, `false` otherwise
     * @inner
     */
    var __is_compare_expr = function(expr) {
        return __get_rel_rank(expr) !== (-1);
    };

    var _ctx_fold_assoc = function(bexpr) {
        var assoc_ops = [
            Expr.Add,
            Expr.Mul,
            Expr.And,
            Expr.Or,
            Expr.Xor
        ];

        // handle an expression of the form: ((x op c1) op c0)
        // where op is an associative operation and c0, c1 are known values.

        // outter expression
        var oexpr = bexpr;
        var oexpr_op = oexpr.constructor;

        if (assoc_ops.indexOf(oexpr_op) !== (-1)) {
            // implied: (oexpr instanceof Expr.BExpr)
            var olhand = bexpr.operands[0];
            var orhand = bexpr.operands[1];

            // inner expression (left hand of the outter one)
            var iexpr = olhand;
            var iexpr_op = iexpr.constructor;

            if (assoc_ops.indexOf(iexpr_op) !== (-1)) {
                // implied: (iexpr instanceof Expr.BExpr)
                var ilhand = iexpr.operands[0];
                var irhand = iexpr.operands[1];

                // ((ilhand op irhand) op orhand) --> (ilhand op (irhand op orhand))
                if ((oexpr_op === iexpr_op) && (orhand instanceof Expr.Val) && (irhand instanceof Expr.Val)) {
                    return new iexpr_op(ilhand.clone(wssa), new iexpr_op(irhand.clone(), orhand.clone()));
                }
            }
        }

        return null;
    };

    var _ctx_fold_arith = function(bexpr) {
        var arith_ops = [
            Expr.Add,
            Expr.Sub
        ];

        // handle an expression of the form: ((x op1 c1) op0 c0)
        // where op1, op0 are arithmetic operations and c0, c1 are known values.

        // outter expression
        var oexpr = bexpr;
        var oexpr_op = oexpr.constructor;

        if (arith_ops.indexOf(oexpr_op) !== (-1)) {
            // implied: (oexpr instanceof Expr.BExpr)
            var olhand = bexpr.operands[0];
            var orhand = bexpr.operands[1];  // b

            // inner expression (left hand of the outter one)
            var iexpr = olhand;
            var iexpr_op = iexpr.constructor;

            if (arith_ops.indexOf(iexpr_op) !== (-1)) {
                // implied: (iexpr instanceof Expr.BExpr)
                var ilhand = iexpr.operands[0]; // x
                var irhand = iexpr.operands[1]; // a

                // ((x iexpr_op a) oexpr_op b)
                if ((orhand instanceof Expr.Val) && (irhand instanceof Expr.Val)) {
                    var op = (oexpr_op === iexpr_op) ? Expr.Add : Expr.Sub;

                    // ((x - a) - b) == (x - (a + b))
                    // ((x + a) + b) == (x + (a + b))
                    // ((x - a) + b) == (x - (a - b))
                    // ((x + a) - b) == (x + (a - b))

                    // generalized case: (x iexpr_op (a op b))
                    return new iexpr_op(ilhand.clone(wssa), new op(irhand.clone(), orhand.clone()));
                }
            }
        }

        return null;
    };

    var _constant_folding = function(bexpr) {
        const operations = {
            'Add': Long.prototype.add,
            'Sub': Long.prototype.sub,
            'Mul': Long.prototype.mul,
            'Div': Long.prototype.div,
            'Mod': Long.prototype.mod,
            'And': Long.prototype.and,
            'Or' : Long.prototype.or,
            'Xor': Long.prototype.xor,
            'Shl': Long.prototype.shl,
            'Shr': Long.prototype.shr
        };

        var _has_msb_set = function(val) {
            const msb = 1 << (val.size - 1);

            return !(val.value.and(msb).isZero());
        };

        // an operation is considered sign-safe if either the operation is sign-insensitive,
        // or the left value cannot be considered as negative
        var _sign_safe = function(opname, val) {
            var signed_ops = ['Shr'];

            return signed_ops.indexOf(opname) === (-1) || !_has_msb_set(val);
        };

        var opname = bexpr.constructor.name;

        if (opname in operations) {
            var lhand = bexpr.operands[0];
            var rhand = bexpr.operands[1];

            if ((lhand instanceof Expr.Val) && (rhand instanceof Expr.Val)) {
                if (_sign_safe(opname, lhand)) {
                    var op = operations[opname];

                    return new Expr.Val(op.call(lhand.value, rhand.value), lhand.size);
                }
            }
        }

        return null;
    };

    var _correct_arith = function(bexpr) {
        var lhand = bexpr.operands[0];
        var rhand = bexpr.operands[1];

        if ((bexpr instanceof Expr.Add) || (bexpr instanceof Expr.Sub)) {
            // x + 0
            // x - 0
            var __is_additive_id = function(expr) {
                const ZERO = new Expr.Val(0, expr.size);

                return expr.equals(ZERO);
            };

            if (__is_additive_id(rhand)) {
                return lhand.clone(wssa);
            }

            // Add is a commutative operator; try also with flipped operands
            if ((bexpr instanceof Expr.Add) && __is_additive_id(lhand)) {
                return rhand.clone(wssa);
            }
        }

        else if ((bexpr instanceof Expr.Mul) || (bexpr instanceof Expr.Div)) {
            // x * 1
            // x / 1
            var __is_multiplicative_id = function(expr) {
                const ONE = new Expr.Val(1, expr.size);

                return expr.equals(ONE);
            };

            if (__is_multiplicative_id(rhand)) {
                return lhand.clone(wssa);
            }

            // Mul is a commutative operator; try also with flipped operands
            if ((bexpr instanceof Expr.Mul) && __is_multiplicative_id(lhand)) {
                return rhand.clone(wssa);
            }
        }

        return null;
    };

    var _negate = function(uexpr) {
        if (uexpr instanceof Expr.BoolNot) {
            var op = uexpr.operands[0];

            if (op instanceof Expr.BExpr) {
                var inner_lhand = op.operands[0];
                var inner_rhand = op.operands[1];

                // deMorgan rules
                if (op instanceof Expr.BoolAnd) {
                    return new Expr.BoolOr(
                        new Expr.BoolNot(inner_lhand.clone(wssa)),
                        new Expr.BoolNot(inner_rhand.clone(wssa))
                    );
                } else if (op instanceof Expr.BoolOr) {
                    return new Expr.BoolAnd(
                        new Expr.BoolNot(inner_lhand.clone(wssa)),
                        new Expr.BoolNot(inner_rhand.clone(wssa))
                    );
                }

                // !(x + y) becomes: (x == -y)
                else if (op instanceof Expr.Add) {
                    return new Expr.EQ(
                        inner_lhand.clone(wssa),
                        new Expr.Neg(inner_rhand.clone(wssa))
                    );
                }

                // !(x - y) becomes: (x == y)
                else if (op instanceof Expr.Sub) {
                    return new Expr.EQ(
                        inner_lhand.clone(wssa),
                        inner_rhand.clone(wssa)
                    );
                }
            }

            else if (op instanceof Expr.UExpr) {
                var inner_op = op.operands[0]; 

                // !(!x) becomes: x
                if (op instanceof Expr.BoolNot) {
                    return inner_op.clone(wssa);
                }
            }

            else if (op instanceof Expr.Val) {
                var vfalse = new Expr.Val(0, 1);
                var vtrue = new Expr.Val(1, 1);

                // !0 becomes: 1, !nonzero becomes: 0
                return op.value.isZero() ? vtrue : vfalse;
            }
        }

        return null;
    };

    var _correct_sign = function(bexpr) {
        var lhand = bexpr.operands[0];
        var rhand = bexpr.operands[1];

        var isNegativeValue = function(e) {
            return (e instanceof Expr.Val) && (e.value.isNegative());
        };

        // x + -y
        if ((bexpr instanceof Expr.Add) && isNegativeValue(rhand)) {
            rhand.value = rhand.value.negate();

            return new Expr.Sub(lhand.clone(wssa), rhand.clone(wssa));
        }

        // x - -y
        else if ((bexpr instanceof Expr.Sub) && isNegativeValue(rhand)) {
            rhand.value = rhand.value.negate();

            return new Expr.Add(lhand.clone(wssa), rhand.clone(wssa));
        }

        return null;
    };

    var _correct_ref = function(uexpr) {
        var op = uexpr.operands[0];

        // &*x
        if ((uexpr instanceof Expr.AddrOf) && (op instanceof Expr.Deref)) {
            return op.operands[0].clone(wssa);
        }

        // *&x
        else if ((uexpr instanceof Expr.Deref) && (op instanceof Expr.AddrOf)) {
            return op.operands[0].clone(wssa);
        }

        return null;
    };

    var _correct_bitwise = function(bexpr) {
        var lhand = bexpr.operands[0];
        var rhand = bexpr.operands[1];

        // create an FF's mask that matches lhand size
        const ffmask = Long.UONE.shl(lhand.size).sub(Long.UONE);

        const ZERO = new Expr.Val(0, lhand.size);
        const FF = new Expr.Val(ffmask, lhand.size);

        if (bexpr instanceof Expr.Xor) {
            // 0 ^ x
            if (lhand.equals(ZERO)) {
                return rhand.clone(wssa);
            }

            // x ^ 0
            if (rhand.equals(ZERO)) {
                return lhand.clone(wssa);
            }

            // x ^ x
            if (rhand.equals(lhand)) {
                return ZERO;
            }

            // x ^ 0xff...
            if (rhand.equals(FF)) {
                return new Expr.Not(lhand.clone(wssa));
            }
        }

        else if (bexpr instanceof Expr.Or) {
            // 0 | x
            if (lhand.equals(ZERO)) {
                return rhand.clone(wssa);
            }

            // x | 0
            if (rhand.equals(ZERO)) {
                return lhand.clone(wssa);
            }

            // x | x
            if (rhand.equals(lhand)) {
                return lhand.clone(wssa);
            }

            // x | 0xff...
            if (rhand.equals(FF)) {
                return FF;
            }
        }

        else if (bexpr instanceof Expr.And) {
            // 0 & x
            if (lhand.equals(ZERO)) {
                return ZERO;
            }

            // x & 0
            if (rhand.equals(ZERO)) {
                return ZERO;
            }

            // x & x
            if (rhand.equals(lhand)) {
                return rhand.clone(wssa);
            }

            // x & 0xff...
            if (rhand.equals(FF)) {
                return lhand.clone(wssa);
            }
        }

        else if (bexpr instanceof Expr.Shr) {
            // 0 >> x
            if (lhand.equals(ZERO)) {
                return ZERO;
            }

            // x >> 0
            if (rhand.equals(ZERO)) {
                return lhand.clone(wssa);
            }
        }

        else if (bexpr instanceof Expr.Shl) {
            // 0 << x
            if (lhand.equals(ZERO)) {
                return ZERO;
            }

            // x << 0
            if (rhand.equals(ZERO)) {
                return lhand.clone(wssa);
            }

            // ((x >> c) << c) becomes: (x & ~((1 << c) - 1))
            if ((lhand instanceof Expr.Shr) && (rhand instanceof Expr.Val)) {
                var inner_lhand = lhand.operands[0];
                var inner_rhand = lhand.operands[1];

                if (inner_rhand instanceof Expr.Val && inner_rhand.equals(rhand)) {
                    var mask = new Expr.Val(Long.UONE.shl(rhand.value).sub(Long.UONE).not(), rhand.size);

                    return new Expr.And(inner_lhand.clone(wssa), mask);
                }
            }
        }

        return null;
    };

    var _equality = function(bexpr) {
        // the following comments demonstrate equality as '==', but this
        // simplification is not limited to that only. rather it applies to 
        // all kind of comparisons.

        if (__is_compare_expr(bexpr)) {
            var lhand = bexpr.operands[0];
            var rhand = bexpr.operands[1];

            if (lhand instanceof Expr.BExpr) {
                var x = lhand.operands[0];
                var y = lhand.operands[1];

                if (y instanceof Expr.Val) {
                    var c1 = y;

                    if (rhand instanceof Expr.Val) {
                        var c2 = rhand;

                        // ((x + c1) == c2) yields (x == c3) where c3 = c2 - c1
                        if (lhand instanceof Expr.Add) {
                            return new bexpr.constructor(x.clone(wssa), new Expr.Sub(c2.clone(), c1.clone()));
                        }

                        // ((x - c1) == c2) yields (x == c3) where c3 = c2 + c1
                        else if (lhand instanceof Expr.Sub) {
                            return new bexpr.constructor(x.clone(wssa), new Expr.Add(c2.clone(), c1.clone()));
                        }
                    }
                }

                if (rhand.equals(new Expr.Val(0, rhand.size))) {

                    // ((x - y) == 0) yields (x == y)
                    if (lhand instanceof Expr.Sub) {
                        return new bexpr.constructor(x.clone(wssa), y.clone(wssa));
                    }

                    // ((x + y) == 0) yields (x == -y)
                    else if (lhand instanceof Expr.Add) {
                        return new bexpr.constructor(x.clone(wssa), new Expr.Neg(y.clone(wssa)));
                    }
                }
            }

            // comparing two known values; that becomes tricky for signed comparisons of incompatible
            // sizes, due to possible sign extention. handle only equality and inequality for now
            else if ((lhand instanceof Expr.Val) && (rhand instanceof Expr.Val)) {
                var vfalse = new Expr.Val(0, 1);
                var vtrue = new Expr.Val(1, 1);
                var are_equal = lhand.equals(rhand);

                if (bexpr instanceof Expr.EQ) {
                    return are_equal ? vtrue : vfalse;
                }

                // TODO: Expr.Val equality considers not only the value itself, but also the value size
                // in bits. since datatypes are not fully supported yet, values may be equal but equality
                // may be false if they differ in size. for that reason, in case they are not equal we
                // rather leave it.
                //
                // [yes, we could check for sizes here, but that would be a pointless workaround]
                else if (bexpr instanceof Expr.NE) {
                    return are_equal ? vfalse : null;
                }
            }
        }

        return null;
    };

    var _converged_cond = function(expr) {
        var __handle_not = function(cmp) {
            // rel inner operands
            var x0 = cmp.operands[0];
            var y0 = cmp.operands[1];

            var rank = __get_rel_rank(cmp) ^ 0b111;
            var cons = __get_rel_expr(rank);

            return cons(x0.clone(wssa), y0.clone(wssa));
        };

        var __handle_or = function(lcmp, rcmp) {
            // lhand inner operands
            var x0 = lcmp.operands[0];
            var y0 = lcmp.operands[1];

            // rhand inner operands
            var x1 = rcmp.operands[0];
            var y1 = rcmp.operands[1];

            // (x LCMP y) || (x RCMP y)
            if (x0.equals(x1) && y0.equals(y1)) {
                // the way the result relation expression is computed is indifferent
                // to how the input relations are ordered, so there is no need to worry
                // about 'or' being a commutative operator
                var rank = __get_rel_rank(lcmp) | __get_rel_rank(rcmp);
                var cons = __get_rel_expr(rank);

                return cons(x0.clone(wssa), y0.clone(wssa));
            }

            return null;
        };

        var __handle_and = function(lcmp, rcmp) {
            // lhand inner operands
            var x0 = lcmp.operands[0];
            var y0 = lcmp.operands[1];

            // rhand inner operands
            var x1 = rcmp.operands[0];
            var y1 = rcmp.operands[1];

            // (x LCMP y) && (x RCMP y)
            if (x0.equals(x1) && y0.equals(y1)) {
                // the way the result relation expression is computed is indifferent
                // to how the input relations are ordered, so there is no need to worry
                // about 'and' being a commutative operator
                var rank = __get_rel_rank(lcmp) & __get_rel_rank(rcmp);
                var cons = __get_rel_expr(rank);

                return cons(x0.clone(wssa), y0.clone(wssa));
            }

            return null;
        };

        var __handle_eq = function(lcmp, rcmp) {
            // lhand inner operands
            var x0 = lcmp.operands[0];
            var y0 = lcmp.operands[1];

            // rhand inner operands
            var x1 = rcmp.operands[0];
            var y1 = rcmp.operands[1];

            // (x LCMP y) == (x RCMP y)
            if (x0.equals(x1) && y0.equals(y1)) {
                // the way the result relation expression is computed is indifferent
                // to how the input relations are ordered, so there is no need to worry
                // about 'equals' being a commutative operator
                var rank = __get_neg_rank(__get_rel_rank(lcmp) ^ __get_rel_rank(rcmp));
                var cons = __get_rel_expr(rank);

                return cons(x0.clone(wssa), y0.clone(wssa));
            }

            return null;
        };

        if (expr instanceof Expr.BoolNot) {
            var op = expr.operands[0];

            if (__is_compare_expr(op)) {
                return __handle_not(op);
            }
        }

        else if (expr instanceof Expr.BoolOr) {
            var bo_lhand = expr.operands[0];
            var bo_rhand = expr.operands[1];

            if (__is_compare_expr(bo_lhand) && __is_compare_expr(bo_rhand)) {
                return __handle_or(bo_lhand, bo_rhand);
            }
        }

        else if (expr instanceof Expr.BoolAnd) {
            var ba_lhand = expr.operands[0];
            var ba_rhand = expr.operands[1];

            if (__is_compare_expr(ba_lhand) && __is_compare_expr(ba_rhand)) {
                return __handle_and(ba_lhand, ba_rhand);
            }
        }

        else if (expr instanceof Expr.EQ) {
            var eq_lhand = expr.operands[0];
            var eq_rhand = expr.operands[1];

            if (__is_compare_expr(eq_lhand) && __is_compare_expr(eq_rhand)) {
                return __handle_eq(eq_lhand, eq_rhand);
            }
        }

        return null;
    };

    var _cond_folding = function(texpr) {
        if (texpr instanceof Expr.TCond) {
            var cond = texpr.operands[0];

            // x = C ? true_expr : false_expr
            if (cond instanceof Expr.Val) {
                return cond.value.isZero() ?
                    texpr.operands[2].clone(wssa) :   // false expr
                    texpr.operands[1].clone(wssa);    // true expr
            }
        }

        return null;
    };

    // --------------------

    // rules that apply to unary exprs
    const _uexpr_rules = [
        _correct_ref,
        _negate,
        _converged_cond
    ];

    // rules that apply to binary exprs
    const _bexpr_rules = [
        _correct_arith,
        _correct_sign,
        _correct_bitwise,
        _equality,
        _converged_cond,
        _constant_folding,
        _ctx_fold_assoc,
        _ctx_fold_arith
    ];

    // rules that apply to ternary exprs
    const _texpr_rules = [
        _cond_folding
    ];

    const _rules_selectors = [
        { cons: Expr.UExpr, set: _uexpr_rules },
        { cons: Expr.BExpr, set: _bexpr_rules },
        { cons: Expr.TExpr, set: _texpr_rules },
    ];

    var _select_rules_set = function(expr) {
        var obj = _rules_selectors.find(function(obj) {
            return (expr instanceof obj.cons);
        });

        return obj ? obj.set : [];
    };

    /**
     * Simplify a given expression in-place, but break as soon as it is modified
     * @param {Expr.Expr} expr An expression instance to simplify
     * @returns {Expr.Expr} Reduced expression, or `null` if `expr` cannot be reduced any further
     */
    var _reduce_expr_once = function(expr) {
        var reduced = null;

        if (expr instanceof Expr.Expr) {
            var rulesset = _select_rules_set(expr);

            for (var i = 0; !reduced && (i < rulesset.length); i++) {
                reduced = rulesset[i](expr);
            }

            if (reduced) {
                expr.replace(reduced);
            }
        }

        return reduced;
    };

    /**
     * Recursively simplify a specified expression and return its simplified version
     * Note that this function replaced `expr` with a new expression.
     * @param {Expr.Expr} expr An expression instance to simplify
     * @returns {Expr.Expr} Reduced expression, or `null` if `expr` cannot be reduced any further
     */
    var _reduce_expr_rec = function(expr) {
        if (expr.operands) {
            // do 'post order' reduction: reduce operands first
            while (expr.operands.some(_reduce_expr_rec)) {
                // empty
            }

            // ... then reduce expr
            return _reduce_expr_once(expr);
        }

        return null;
    };

    /**
     * Simplify a given expression in-place until it cannot be simplified any further
     * @param {Expr.Expr} expr An expression instance to simplify
     */
    var _reduce_expr = function(expr) {
        while (expr) {
            expr = _reduce_expr_rec(expr);
        }
    };

    /**
     * Simplify a given statement in-place, along with its enclosed expressions, until
     * they cannot be simplified any further
     * @param {Expr.Expr} stmt An expression instance to simplify
     */
    var _reduce_stmt = function(stmt) {
        stmt.expressions.forEach(_reduce_expr);
    };

    // note: simplifications are done in-place
    return {
        reduce_expr: _reduce_expr,
        reduce_stmt: _reduce_stmt
    };
});