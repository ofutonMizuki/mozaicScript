// compiler/lexer.ts — mozaicScript 字句解析器

export type TK =
    | 'import' | 'as' | 'type' | 'class' | 'function'
    | 'let' | 'const' | 'return' | 'break'
    | 'if' | 'else' | 'while' | 'for' | 'new' | 'this'
    | 'constructor' | 'public' | 'private' | 'mocp' | 'protected'
    | 'true' | 'false'
    | 'intlit' | 'floatlit' | 'strlit'
    | '(' | ')' | '{' | '}' | '[' | ']'
    | '.' | ',' | ':' | ';'
    | '+' | '-' | '*' | '/' | '%'
    | '=' | '==' | '!=' | '<' | '>' | '<=' | '>='
    | '||' | '&&' | '!'
    | 'ident'
    | 'EOF';

export interface Token {
    kind: TK;
    value: string;
    line: number;
    col: number;
}

// Object.create(null) でプロトタイプなしオブジェクトを作成 (constructor キーの衝突を回避)
const KEYWORDS = Object.assign(Object.create(null), {
    import: 'import' as TK, as: 'as' as TK, type: 'type' as TK, class: 'class' as TK, function: 'function' as TK,
    let: 'let' as TK, const: 'const' as TK, return: 'return' as TK, break: 'break' as TK,
    if: 'if' as TK, else: 'else' as TK, while: 'while' as TK, for: 'for' as TK, new: 'new' as TK, this: 'this' as TK,
    constructor: 'constructor' as TK, public: 'public' as TK, private: 'private' as TK,
    mocp: 'mocp' as TK, protected: 'protected' as TK,
    true: 'true' as TK, false: 'false' as TK,
}) as Record<string, TK>;

export class LexError extends Error {
    constructor(msg: string, public line: number, public col: number, public file: string) {
        super(`${file}:${line}:${col}: LexError: ${msg}`);
    }
}

export function lex(src: string, filename: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let line = 1;
    let lineStart = 0;

    function col(): number { return i - lineStart + 1; }

    function advance(): string {
        const c = src[i++];
        if (c === '\n') { line++; lineStart = i; }
        return c;
    }

    function peek(offset = 0): string {
        return src[i + offset] ?? '';
    }

    function tok(kind: TK, value: string, l: number, c: number): Token {
        return { kind, value, line: l, col: c };
    }

    while (i < src.length) {
        // 空白をスキップ
        if (/[ \t\r\n]/.test(src[i])) { advance(); continue; }

        // 行コメント
        if (src[i] === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') advance();
            continue;
        }

        // ブロックコメント
        if (src[i] === '/' && src[i + 1] === '*') {
            const sl = line, sc = col();
            advance(); advance(); // /*
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) advance();
            if (i >= src.length) throw new LexError('Unterminated block comment', sl, sc, filename);
            advance(); advance(); // */
            continue;
        }

        const l = line, c = col();
        const ch = src[i];

        // 文字列リテラル
        if (ch === '"') {
            advance(); // consume "
            let str = '';
            while (i < src.length && src[i] !== '"') {
                if (src[i] === '\\') {
                    advance();
                    const esc = advance();
                    switch (esc) {
                        case 'n':  str += '\n'; break;
                        case 't':  str += '\t'; break;
                        case '\\': str += '\\'; break;
                        case '"':  str += '"';  break;
                        case '0':  str += '\0'; break;
                        case 'r':  str += '\r'; break;
                        default:   str += esc;
                    }
                } else {
                    str += advance();
                }
            }
            if (i >= src.length) throw new LexError('Unterminated string literal', l, c, filename);
            advance(); // consume "
            tokens.push(tok('strlit', str, l, c));
            continue;
        }

        // 数値リテラル（整数 / 浮動小数点）
        if (/[0-9]/.test(ch)) {
            let num = '';
            while (i < src.length && /[0-9]/.test(src[i])) num += advance();
            if (i < src.length && src[i] === '.' && /[0-9]/.test(src[i + 1])) {
                num += advance(); // .
                while (i < src.length && /[0-9]/.test(src[i])) num += advance();
                tokens.push(tok('floatlit', num, l, c));
            } else {
                tokens.push(tok('intlit', num, l, c));
            }
            continue;
        }

        // 識別子 / キーワード
        if (/[a-zA-Z_]/.test(ch)) {
            let ident = '';
            while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) ident += advance();
            tokens.push(tok(KEYWORDS[ident] ?? 'ident', ident, l, c));
            continue;
        }

        // 演算子・句読点
        advance(); // consume ch
        switch (ch) {
            case '(': tokens.push(tok('(', ch, l, c)); break;
            case ')': tokens.push(tok(')', ch, l, c)); break;
            case '{': tokens.push(tok('{', ch, l, c)); break;
            case '}': tokens.push(tok('}', ch, l, c)); break;
            case '[': tokens.push(tok('[', ch, l, c)); break;
            case ']': tokens.push(tok(']', ch, l, c)); break;
            case '.': tokens.push(tok('.', ch, l, c)); break;
            case ',': tokens.push(tok(',', ch, l, c)); break;
            case ':': tokens.push(tok(':', ch, l, c)); break;
            case ';': tokens.push(tok(';', ch, l, c)); break;
            case '+': tokens.push(tok('+', ch, l, c)); break;
            case '-': tokens.push(tok('-', ch, l, c)); break;
            case '*': tokens.push(tok('*', ch, l, c)); break;
            case '/': tokens.push(tok('/', ch, l, c)); break;
            case '%': tokens.push(tok('%', ch, l, c)); break;
            case '!':
                if (src[i] === '=') { advance(); tokens.push(tok('!=', '!=', l, c)); }
                else tokens.push(tok('!', ch, l, c));
                break;
            case '=':
                if (src[i] === '=') { advance(); tokens.push(tok('==', '==', l, c)); }
                else tokens.push(tok('=', ch, l, c));
                break;
            case '<':
                if (src[i] === '=') { advance(); tokens.push(tok('<=', '<=', l, c)); }
                else tokens.push(tok('<', ch, l, c));
                break;
            case '>':
                if (src[i] === '=') { advance(); tokens.push(tok('>=', '>=', l, c)); }
                else tokens.push(tok('>', ch, l, c));
                break;
            case '|':
                if (src[i] === '|') { advance(); tokens.push(tok('||', '||', l, c)); }
                else throw new LexError(`Unexpected character '|'`, l, c, filename);
                break;
            case '&':
                if (src[i] === '&') { advance(); tokens.push(tok('&&', '&&', l, c)); }
                else throw new LexError(`Unexpected character '&'`, l, c, filename);
                break;
            default:
                throw new LexError(`Unexpected character '${ch}'`, l, c, filename);
        }
    }

    tokens.push({ kind: 'EOF', value: '', line, col: col() });
    return tokens;
}
