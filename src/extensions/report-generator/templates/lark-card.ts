export interface LarkText {
  tag: "plain_text" | "lark_md";
  content: string;
}

export interface LarkMarkdownElement {
  tag: "markdown";
  content: string;
}

export interface LarkHrElement {
  tag: "hr";
}

export interface LarkCollapsiblePanel {
  tag: "collapsible_panel";
  expanded: boolean;
  header: { title: LarkText };
  elements: LarkMarkdownElement[];
}

export interface LarkTableColumn {
  name: string;
  display_name: string;
  data_type: "text" | "lark_md" | "number" | "options" | "persons" | "date";
  horizontal_align?: "left" | "center" | "right";
  vertical_align?: "top" | "middle" | "bottom";
}

export interface LarkTableElement {
  tag: "table";
  page_size: number;
  row_height: "low" | "middle" | "high" | `${number}px`;
  freeze_first_column?: boolean;
  header_style?: {
    text_align?: "left" | "center" | "right";
    text_size?: "normal" | "heading";
    background_style?: "none" | "grey";
    text_color?: "default" | "grey";
    bold?: boolean;
    lines?: number;
  };
  columns: LarkTableColumn[];
  rows: Array<Record<string, string | number | string[]>>;
}

export type LarkElement =
  | LarkMarkdownElement
  | LarkHrElement
  | LarkCollapsiblePanel
  | LarkTableElement;

export interface LarkCard {
  config: { wide_screen_mode: boolean };
  header: {
    title: LarkText;
    template: string;
  };
  elements: LarkElement[];
}
