import Foundation

// Mirrors client/src/services/api.ts's ApiError: carries the HTTP status
// alongside the server's own error message (from a `{ error: string }` body)
// so callers can distinguish e.g. a 404 without string-matching the message.
struct APIError: Error, LocalizedError {
    let message: String
    let status: Int

    var errorDescription: String? { message }
}
