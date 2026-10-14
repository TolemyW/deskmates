/** `sha256:` followed by exactly 64 lowercase hex digits, as `docker image inspect` prints it. */
export declare const IMAGE_ID_PATTERN: RegExp;

/** True when `value` is a Docker image ID. */
export declare function isImageId(value: unknown): value is string;

/** Return `value` when it is a Docker image ID; throw otherwise, naming `what`. */
export declare function requireImageId(value: string | undefined, what: string): string;
