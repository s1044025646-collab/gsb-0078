export class DomainError extends Error {
  code: string;
  status: number;
  detail?: unknown;
  constructor(code: string, message: string, status = 400, detail?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export const Errors = {
  notFound: (what: string) => new DomainError('NOT_FOUND', `${what} 不存在`, 404),
  capacity: (detail: unknown) => new DomainError('CAPACITY_EXCEEDED', '容量不足', 409, detail),
  shortage: (detail: unknown) => new DomainError('SHORTAGE', '物资短缺', 409, detail),
  conflict: (msg: string, detail?: unknown) => new DomainError('CONFLICT', msg, 409, detail),
  invalid: (msg: string) => new DomainError('INVALID', msg, 400),
};
