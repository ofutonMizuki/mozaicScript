// 共通型定義。リンタ全体で参照される。

export interface BuiltinParam {
    name: string;
    type: string;
}

export interface BuiltinEntry {
    id: string;
    name: string;
    group: string;
    params: BuiltinParam[];
    returns: string;
    return_semantics?: string;
    defined_in: string;
    referenced_in?: string[];
    notes?: string;
    requires_design_decision?: boolean;
}

export interface IrNodeField {
    name: string;
    type: string;
    required: boolean;
}

export interface IrNodeEntry {
    id: string;
    type: string;
    category: "decl" | "expr" | "stmt" | "literal";
    fields: IrNodeField[];
    defined_in: string;
    must_appear_in_ir_node_list: boolean;
    referenced_in?: string[];
    notes?: string;
    requires_design_decision?: boolean;
}

export interface CorelibEntry {
    id: string;
    kind: "method" | "global_fn" | "field" | "constructor";
    owner?: string;
    signature: string;
    defined_in: string;
    lowers_to?: string;
    referenced_in?: string[];
    notes?: string;
    requires_design_decision?: boolean;
}

export interface Catalog {
    builtins: BuiltinEntry[];
    irNodes: IrNodeEntry[];
    corelib: CorelibEntry[];
}

// 仕様 Markdown のロード結果
export interface SpecDoc {
    file: string;            // ファイル名 (e.g. "mozaicScript-spec.md")
    fullPath: string;
    text: string;
    lines: string[];
    headings: Heading[];
}

export interface Heading {
    level: number;           // 1..N
    text: string;            // "9.11 マルチスレッド命令" 等の見出し本文（# 抜き）
    line: number;            // 1-based
    sectionNumber: string | null; // "9.11" など、先頭の番号 (抽出できなかったら null)
}

export type SpecDocs = Map<string, SpecDoc>;

// リンタの違反レポート
export interface Violation {
    ruleId: string;
    severity: "error" | "warning" | "info" | "design-decision";
    message: string;
    location: {
        catalog?: string;      // YAML 上の id
        spec?: string;         // <file>#<anchor>
        line?: number;
    };
    expected?: string;
    actual?: string;
    requires_design_decision?: boolean;
}

export interface LintReport {
    summary: {
        total: number;
        errors: number;
        warnings: number;
        designDecisions: number;
        byRule: Record<string, number>;
    };
    violations: Violation[];
}

export interface Rule {
    id: string;
    description: string;
    run(catalog: Catalog, docs: SpecDocs): Violation[];
}
