declare module "qrcode" {
  export interface QRCodeModules {
    size: number;
    /** Row-major; 1 = dark module. */
    data: Uint8Array;
  }
  export interface QRCodeResult {
    modules: QRCodeModules;
  }
  export function create(text: string, options?: Record<string, unknown>): QRCodeResult;
  export function toString(text: string, options?: Record<string, unknown>): Promise<string>;
  const QRCode: {
    create: typeof create;
    toString: typeof toString;
  };
  export default QRCode;
}
