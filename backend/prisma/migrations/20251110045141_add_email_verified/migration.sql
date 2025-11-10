-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "kycStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "kycProvider" TEXT,
    "kycCompletedAt" DATETIME,
    "kycDetails" TEXT,
    "tradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "verificationRetries" INTEGER NOT NULL DEFAULT 0,
    "lastVerificationAttempt" DATETIME,
    "idVerified" BOOLEAN NOT NULL DEFAULT false,
    "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "phoneNumber" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_users" ("createdAt", "email", "id", "idVerified", "kycCompletedAt", "kycDetails", "kycProvider", "kycStatus", "lastVerificationAttempt", "phoneNumber", "phoneVerified", "tradingEnabled", "updatedAt", "verificationRetries") SELECT "createdAt", "email", "id", "idVerified", "kycCompletedAt", "kycDetails", "kycProvider", "kycStatus", "lastVerificationAttempt", "phoneNumber", "phoneVerified", "tradingEnabled", "updatedAt", "verificationRetries" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
