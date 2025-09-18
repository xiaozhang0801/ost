-- CreateTable
CREATE TABLE "ShippingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "chargeBy" TEXT NOT NULL,
    "countries" JSONB NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ShippingRange" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL,
    "fromVal" REAL NOT NULL,
    "toVal" REAL NOT NULL,
    "unit" TEXT NOT NULL,
    "pricePer" REAL NOT NULL,
    "fee" REAL NOT NULL,
    "feeUnit" TEXT NOT NULL,
    CONSTRAINT "ShippingRange_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ShippingRule" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
