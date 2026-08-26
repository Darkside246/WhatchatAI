declare module 'pdf-parse' {
  export class PasswordException extends Error {}
  export class InvalidPDFException extends Error {}

  export interface PDFTextResult {
    text: string;
    pages?: number;
    total?: number;
  }

  export interface PDFParseOptions {
    data: Uint8Array;
  }

  export class PDFParse {
    constructor(options: PDFParseOptions);
    getText(): Promise<PDFTextResult>;
    destroy(): Promise<void>;
  }
}
