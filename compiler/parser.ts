// compiler/parser.ts — mozaicScript 再帰下降パーサー

import { Token, TK } from './lexer';
import * as A from './ast';

export class ParseError extends Error {
    constructor(msg: string, public pos: A.Pos) {
        super(`${pos.file}:${pos.line}:${pos.col}: ParseError: ${msg}`);
    }
}

class Parser {
    private pos = 0;
    constructor(private tokens: Token[], private filename: string) {}

    // ── トークン操作 ─────────────────────────────────────────────────────

    private peek(offset = 0): Token {
        const idx = Math.min(this.pos + offset, this.tokens.length - 1);
        return this.tokens[idx];
    }

    private advance(): Token {
        return this.tokens[this.pos++];
    }

    private at(kind: TK, offset = 0): boolean {
        return this.peek(offset).kind === kind;
    }

    private atIdent(value: string, offset = 0): boolean {
        const t = this.peek(offset);
        return t.kind === 'ident' && t.value === value;
    }

    private eat(kind: TK): Token {
        const t = this.peek();
        if (t.kind !== kind) this.error(`Expected '${kind}' but got '${t.kind}'`);
        return this.advance();
    }

    private eatIdent(value?: string): Token {
        const t = this.peek();
        if (t.kind !== 'ident') this.error(`Expected identifier but got '${t.kind}'`);
        if (value !== undefined && t.value !== value) this.error(`Expected '${value}' but got '${t.value}'`);
        return this.advance();
    }

    private tryEat(kind: TK): boolean {
        if (this.at(kind)) { this.advance(); return true; }
        return false;
    }

    private pos2(): A.Pos {
        const t = this.peek();
        return { line: t.line, col: t.col, file: this.filename };
    }

    private error(msg: string): never {
        throw new ParseError(msg, this.pos2());
    }

    private save(): number { return this.pos; }
    private restore(saved: number): void { this.pos = saved; }

    // ── 型パース ─────────────────────────────────────────────────────────

    private parseType(): A.PType {
        const name = this.peek();
        if (name.kind !== 'ident') this.error(`Expected type name but got '${name.kind}'`);
        this.advance();
        let typeName = name.value;
        // 名前空間付き型: Geo.Vec2 など
        while (this.at('.') && this.tokens[this.pos + 1]?.kind === 'ident') {
            this.advance(); // '.'
            typeName = typeName + '.' + this.eatIdent().value;
        }
        const args = this.tryParseTypeArgs() ?? [];
        return { name: typeName, args };
    }

    // '<' TypeArg (',' TypeArg)* '>' をパース。失敗したら null を返しバックトラック
    private tryParseTypeArgs(): A.PType[] | null {
        if (!this.at('<')) return null;
        const saved = this.save();
        try {
            this.advance(); // <
            const args: A.PType[] = [this.parseType()];
            while (this.at(',')) { this.advance(); args.push(this.parseType()); }
            if (!this.at('>')) { this.restore(saved); return null; }
            this.advance(); // >
            return args;
        } catch {
            this.restore(saved);
            return null;
        }
    }

    // ── アクセス修飾子 ───────────────────────────────────────────────────

    private parseAccessMod(): A.PAccessMod {
        if (this.at('mocp')) {
            this.advance();
            this.eat('public');
            return 'mocp public';
        }
        if (this.at('public'))  { this.advance(); return 'public'; }
        if (this.at('private')) { this.advance(); return 'private'; }
        this.error(`Expected access modifier (public/private/mocp public)`);
    }

    // ── クラスパース ─────────────────────────────────────────────────────

    private parseClassDecl(access: A.PAccessMod): A.PClassDecl {
        const pos = this.pos2();
        this.eat('class');
        const name = this.eatIdent().value;

        // ジェネリクス型パラメータ
        let typeParams: string[] = [];
        if (this.at('<')) {
            this.advance();
            typeParams.push(this.eatIdent().value);
            while (this.at(',')) { this.advance(); typeParams.push(this.eatIdent().value); }
            this.eat('>');
        }

        this.eat('{');
        const members: A.PClassMember[] = [];
        while (!this.at('}') && !this.at('EOF')) {
            members.push(this.parseClassMember());
        }
        this.eat('}');

        return { kind: 'class', access, name, typeParams, members, pos };
    }

    private parseClassMember(): A.PClassMember {
        const pos = this.pos2();
        const access = this.parseAccessMod();

        // フィールド宣言
        if (this.at('let') || this.at('const')) {
            const mut = this.peek().kind === 'let';
            this.advance();
            const name = this.eatIdent().value;
            this.eat(':');
            const type = this.parseType();
            this.eat(';');
            return { kind: 'field', access, mut, name, type, pos };
        }

        // コンストラクタ
        if (this.at('constructor')) {
            this.advance();
            const params = this.parseParams();
            const body = this.parseBlock();
            return {
                kind: 'method', access, name: 'constructor',
                typeParams: [], params, returnType: { name: 'void', args: [] }, body, pos
            };
        }

        // 通常メソッド（function キーワードあり）
        if (this.at('function')) {
            this.advance();
            const name = this.parseMethodName();
            const typeParams = this.parseTypeParamList();
            const params = this.parseParams();
            this.eat(':');
            const returnType = this.parseType();
            const body = this.parseBlock();
            return { kind: 'method', access, name, typeParams, params, returnType, body, pos };
        }

        // 演算子メソッド（function キーワードなし）
        const name = this.parseOperatorMethodName();
        const typeParams = this.parseTypeParamList();
        const params = this.parseParams();
        this.eat(':');
        const returnType = this.parseType();
        const body = this.parseBlock();
        return { kind: 'method', access, name, typeParams, params, returnType, body, pos };
    }

    // 通常メソッド名（function の後）
    private parseMethodName(): string {
        return this.eatIdent().value;
    }

    // operator+, operator==, operator[], operator_set[], operatorNot, etc.
    private parseOperatorMethodName(): string {
        const t = this.peek();
        if (t.kind !== 'ident') this.error(`Expected method name`);
        const ident = t.value;
        this.advance();

        if (ident === 'operator') {
            // operator + - * / % == < > || && []
            const op = this.peek();
            switch (op.kind) {
                case '+': this.advance(); return 'operator+';
                case '-': this.advance(); return 'operator-';
                case '*': this.advance(); return 'operator*';
                case '/': this.advance(); return 'operator/';
                case '%': this.advance(); return 'operator%';
                case '==': this.advance(); return 'operator==';
                case '<':  this.advance(); return 'operator<';
                case '>':  this.advance(); return 'operator>';
                case '||': this.advance(); return 'operator||';
                case '&&': this.advance(); return 'operator&&';
                case '[':  this.advance(); this.eat(']'); return 'operator[]';
                default: return 'operator';
            }
        }

        if (ident === 'operator_set') {
            this.eat('['); this.eat(']');
            return 'operator_set[]';
        }

        // operatorNot, operatorNeg, getBits, etc.
        return ident;
    }

    // '<' T (',' T)* '>' の型パラメータリスト（省略可）
    private parseTypeParamList(): string[] {
        if (!this.at('<')) return [];
        const saved = this.save();
        try {
            this.advance(); // <
            const params: string[] = [this.eatIdent().value];
            while (this.at(',')) { this.advance(); params.push(this.eatIdent().value); }
            this.eat('>');
            return params;
        } catch {
            this.restore(saved);
            return [];
        }
    }

    // '(' (name ':' type (',' name ':' type)*)? ')'
    private parseParams(): { name: string; type: A.PType }[] {
        this.eat('(');
        const params: { name: string; type: A.PType }[] = [];
        if (!this.at(')')) {
            params.push(this.parseParam());
            while (this.at(',')) { this.advance(); params.push(this.parseParam()); }
        }
        this.eat(')');
        return params;
    }

    private parseParam(): { name: string; type: A.PType } {
        const name = this.eatIdent().value;
        this.eat(':');
        const type = this.parseType();
        return { name, type };
    }

    // ── 関数宣言 ─────────────────────────────────────────────────────────

    private parseFunctionDecl(access: A.PAccessMod): A.PFunctionDecl {
        const pos = this.pos2();
        this.eat('function');
        const name = this.eatIdent().value;
        const typeParams = this.parseTypeParamList();
        const params = this.parseParams();
        this.eat(':');
        const returnType = this.parseType();
        const body = this.parseBlock();
        return { kind: 'function', access, name, typeParams, params, returnType, body, pos };
    }

    // ── ブロック・文 ─────────────────────────────────────────────────────

    private parseBlock(): A.PStmt[] {
        this.eat('{');
        const stmts: A.PStmt[] = [];
        while (!this.at('}') && !this.at('EOF')) {
            stmts.push(this.parseStmt());
        }
        this.eat('}');
        return stmts;
    }

    private parseStmt(): A.PStmt {
        const pos = this.pos2();

        // 変数宣言
        if (this.at('let') || this.at('const')) {
            const mut = this.peek().kind === 'let';
            this.advance();
            const name = this.eatIdent().value;
            this.eat(':');
            const type = this.parseType();
            this.eat('=');
            const value = this.parseExpr();
            this.eat(';');
            return { kind: 'vardecl', mut, name, type, value, pos };
        }

        // return
        if (this.at('return')) {
            this.advance();
            if (this.at(';')) { this.advance(); return { kind: 'return', value: null, pos }; }
            const value = this.parseExpr();
            this.eat(';');
            return { kind: 'return', value, pos };
        }

        // break
        if (this.at('break')) {
            this.advance(); this.eat(';');
            return { kind: 'break', pos };
        }

        // 裸ブロック { ... }
        if (this.at('{')) {
            const body = this.parseBlock();
            return { kind: 'block', body, pos };
        }

        // if
        if (this.at('if')) return this.parseIfStmt();

        // while
        if (this.at('while')) {
            this.advance();
            this.eat('(');
            const cond = this.parseExpr();
            this.eat(')');
            const body = this.parseBlock();
            return { kind: 'while', cond, body, pos };
        }

        // for
        if (this.at('for')) {
            this.advance();
            this.eat('(');
            // init: VarDecl (let/const ... ;)
            const initPos = this.pos2();
            if (!this.at('let') && !this.at('const')) this.error('Expected let/const in for init');
            const mut = this.peek().kind === 'let';
            this.advance();
            const initName = this.eatIdent().value;
            this.eat(':');
            const initType = this.parseType();
            this.eat('=');
            const initValue = this.parseExpr();
            this.eat(';');
            const init: A.PVarDecl = { kind: 'vardecl', mut, name: initName, type: initType, value: initValue, pos: initPos };

            const cond = this.parseExpr();
            this.eat(';');

            // update: assignment or expression (no semicolon)
            const update = this.parseForUpdate();
            this.eat(')');
            const body = this.parseBlock();
            return { kind: 'for', init, cond, update, body, pos };
        }

        // 代入または式文（前者は lvalue = expr の形）
        return this.parseAssignOrExprStmt();
    }

    private parseIfStmt(): A.PIfStmt {
        const pos = this.pos2();
        this.eat('if');
        this.eat('(');
        const cond = this.parseExpr();
        this.eat(')');
        const body = this.parseBlock();

        let elseBody: A.PStmt[] | null = null;
        let elseIf: A.PIfStmt | null = null;

        if (this.at('else')) {
            this.advance();
            if (this.at('if')) {
                elseIf = this.parseIfStmt();
            } else {
                elseBody = this.parseBlock();
            }
        }

        return { kind: 'if', cond, body, elseBody, elseIf, pos };
    }

    // for の update 部分: `lvalue = expr` または `expr`（セミコロンなし）
    private parseForUpdate(): A.PAssignStmt | A.PExprStmt {
        const pos = this.pos2();
        // lvalue = ... かどうか先読みして判断
        // 単純に postfix expr をパースし、次が = なら代入
        const saved = this.save();
        try {
            const lhs = this.parsePostfix();
            if (this.at('=')) {
                this.advance();
                const rhs = this.parseExpr();
                return { kind: 'assign', target: lhs, value: rhs, pos };
            }
            // = ではない → 式文として返す
            return { kind: 'exprstmt', expr: lhs, pos };
        } catch {
            this.restore(saved);
            const expr = this.parseExpr();
            return { kind: 'exprstmt', expr, pos };
        }
    }

    // 代入文 or 式文
    private parseAssignOrExprStmt(): A.PStmt {
        const pos = this.pos2();
        const saved = this.save();
        try {
            const lhs = this.parsePostfix();
            if (this.at('=')) {
                this.advance();
                const rhs = this.parseExpr();
                this.eat(';');
                return { kind: 'assign', target: lhs, value: rhs, pos };
            }
            // 式文（メソッド呼び出し等）
            // lhs をそのまま式として使う（すでに parsePostfix 済み）
            // ただし lhs が完全な式（引数パース済みのメソッド呼び出し等）である必要がある
            this.eat(';');
            return { kind: 'exprstmt', expr: lhs, pos };
        } catch {
            this.restore(saved);
            const expr = this.parseExpr();
            this.eat(';');
            return { kind: 'exprstmt', expr, pos };
        }
    }

    // ── 式パース（優先順位付き再帰下降）────────────────────────────────

    private parseExpr(): A.PExpr { return this.parseOr(); }

    private parseOr(): A.PExpr {
        let left = this.parseAnd();
        while (this.at('||')) {
            const pos = this.pos2(); this.advance();
            left = { kind: 'bin', op: '||', left, right: this.parseAnd(), pos };
        }
        return left;
    }

    private parseAnd(): A.PExpr {
        let left = this.parseEq();
        while (this.at('&&')) {
            const pos = this.pos2(); this.advance();
            left = { kind: 'bin', op: '&&', left, right: this.parseEq(), pos };
        }
        return left;
    }

    private parseEq(): A.PExpr {
        let left = this.parseCmp();
        while (this.at('==') || this.at('!=')) {
            const pos = this.pos2();
            const op = this.peek().kind; this.advance();
            left = { kind: 'bin', op, left, right: this.parseCmp(), pos };
        }
        return left;
    }

    private parseCmp(): A.PExpr {
        let left = this.parseAdd();
        while (this.at('<') || this.at('>') || this.at('<=') || this.at('>=')) {
            const pos = this.pos2();
            const op = this.peek().kind; this.advance();
            left = { kind: 'bin', op, left, right: this.parseAdd(), pos };
        }
        return left;
    }

    private parseAdd(): A.PExpr {
        let left = this.parseMul();
        while (this.at('+') || this.at('-')) {
            const pos = this.pos2();
            const op = this.peek().kind; this.advance();
            left = { kind: 'bin', op, left, right: this.parseMul(), pos };
        }
        return left;
    }

    private parseMul(): A.PExpr {
        let left = this.parseUnary();
        while (this.at('*') || this.at('/') || this.at('%')) {
            const pos = this.pos2();
            const op = this.peek().kind; this.advance();
            left = { kind: 'bin', op, left, right: this.parseUnary(), pos };
        }
        return left;
    }

    private parseUnary(): A.PExpr {
        const pos = this.pos2();
        if (this.at('!')) { this.advance(); return { kind: 'unary', op: '!', expr: this.parseUnary(), pos }; }
        if (this.at('-')) { this.advance(); return { kind: 'unary', op: '-', expr: this.parseUnary(), pos }; }
        return this.parsePostfix();
    }

    private parsePostfix(): A.PExpr {
        let expr = this.parsePrimary();
        while (true) {
            const pos = this.pos2();
            if (this.at('.')) {
                this.advance();
                const member = this.eatIdent().value;
                // メソッド呼び出し
                if (this.at('(') || this.at('<')) {
                    const typeArgs = this.tryParseTypeArgs() ?? [];
                    if (this.at('(')) {
                        this.eat('(');
                        const args = this.parseArgList();
                        this.eat(')');
                        expr = { kind: 'methodcall', obj: expr, method: member, typeArgs, args, pos };
                    } else {
                        expr = { kind: 'member', obj: expr, member, pos };
                    }
                } else {
                    expr = { kind: 'member', obj: expr, member, pos };
                }
            } else if (this.at('[')) {
                this.advance();
                const index = this.parseExpr();
                this.eat(']');
                expr = { kind: 'index', obj: expr, index, pos };
            } else {
                break;
            }
        }
        return expr;
    }

    private parsePrimary(): A.PExpr {
        const pos = this.pos2();

        // new
        if (this.at('new')) {
            this.advance();
            const type = this.parseType();
            this.eat('(');
            const args = this.parseArgList();
            this.eat(')');
            return { kind: 'new', type, args, pos };
        }

        // this
        if (this.at('this')) {
            this.advance();
            return { kind: 'this', pos };
        }

        // true / false
        if (this.at('true'))  { this.advance(); return { kind: 'boollit', value: true,  pos }; }
        if (this.at('false')) { this.advance(); return { kind: 'boollit', value: false, pos }; }

        // 文字列リテラル
        if (this.at('strlit')) {
            const t = this.advance();
            return { kind: 'strlit', value: t.value, pos };
        }

        // 数値リテラル
        if (this.at('intlit')) {
            const t = this.advance();
            return { kind: 'intlit', value: parseInt(t.value, 10), pos };
        }
        if (this.at('floatlit')) {
            const t = this.advance();
            return { kind: 'floatlit', value: parseFloat(t.value), pos };
        }

        // 括弧式
        if (this.at('(')) {
            this.advance();
            const expr = this.parseExpr();
            this.eat(')');
            return expr;
        }

        // 識別子（関数呼び出しまたは変数参照）
        if (this.at('ident')) {
            const name = this.advance().value;
            // 型引数付き関数呼び出し or 通常呼び出し
            if (this.at('(') || this.at('<')) {
                const typeArgs = this.tryParseTypeArgs() ?? [];
                if (this.at('(')) {
                    this.advance();
                    const args = this.parseArgList();
                    this.eat(')');
                    return { kind: 'call', name, typeArgs, args, pos };
                }
            }
            return { kind: 'ident', name, pos };
        }

        this.error(`Unexpected token '${this.peek().kind}' (value: '${this.peek().value}')`);
    }

    private parseArgList(): A.PExpr[] {
        const args: A.PExpr[] = [];
        if (!this.at(')')) {
            args.push(this.parseExpr());
            while (this.at(',')) { this.advance(); args.push(this.parseExpr()); }
        }
        return args;
    }

    // ── ファイルパース（エントリーポイント）──────────────────────────────

    parseFile(): A.PFile {
        const filename = this.filename;
        const isMoc = filename.endsWith('.moc');
        const decls: A.PTopLevelDecl[] = [];

        while (!this.at('EOF')) {
            const pos = this.pos2();

            // import
            if (this.at('import')) {
                this.advance();
                const pathTok = this.eat('strlit');
                this.eat('as');
                let namespace: string | null;
                if (this.at('*')) { this.advance(); namespace = null; }
                else namespace = this.eatIdent().value;
                this.eat(';');
                decls.push({ kind: 'import', path: pathTok.value, namespace, pos });
                continue;
            }

            // type alias
            if (this.at('type')) {
                this.advance();
                const name = this.eatIdent().value;
                this.eat('=');
                const type = this.parseType();
                this.eat(';');
                decls.push({ kind: 'typealias', name, type, pos });
                continue;
            }

            // アクセス修飾子付き宣言
            const access = this.parseAccessMod();

            if (this.at('class')) {
                decls.push(this.parseClassDecl(access));
                continue;
            }

            if (this.at('function')) {
                decls.push(this.parseFunctionDecl(access));
                continue;
            }

            // トップレベル変数宣言
            if (this.at('let') || this.at('const')) {
                const mut = this.peek().kind === 'let';
                this.advance();
                const name = this.eatIdent().value;
                this.eat(':');
                const type = this.parseType();
                this.eat('=');
                const value = this.parseExpr();
                this.eat(';');
                decls.push({ kind: 'vardecl', mut, name, type, value, pos });
                continue;
            }

            this.error(`Unexpected token at top level: '${this.peek().kind}'`);
        }

        return { filename, isMoc, decls };
    }
}

export function parse(tokens: Token[], filename: string): A.PFile {
    return new Parser(tokens, filename).parseFile();
}
