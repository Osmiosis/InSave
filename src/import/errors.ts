// Raised when an uploaded file cannot be read as an Instagram saved-posts export.
// Carries a user-facing message safe to show directly.
export class ImportError extends Error {
  constructor(message = "We couldn't read your saved posts from this file.") {
    super(message);
    this.name = "ImportError";
  }
}
