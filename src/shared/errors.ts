export class AppError extends Error {
    constructor(
        public code: string,
        public status = 409,
        message = 'Действие недоступно. Обновите данные.',
        public retryable = false,
    ) {
        super(message);
    }
}

export function ensure(condition: unknown, code: string, status = 409, message?: string): asserts condition {
    if (!condition) {
        throw new AppError(code, status, message);
    }
}
