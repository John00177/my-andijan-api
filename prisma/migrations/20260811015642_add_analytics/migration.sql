-- CreateTable
CREATE TABLE "business_analytics" (
    "id" SERIAL NOT NULL,
    "business_id" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "page_views" INTEGER NOT NULL DEFAULT 0,
    "call_clicks" INTEGER NOT NULL DEFAULT 0,
    "direction_clicks" INTEGER NOT NULL DEFAULT 0,
    "favorite_clicks" INTEGER NOT NULL DEFAULT 0,
    "share_clicks" INTEGER NOT NULL DEFAULT 0,
    "website_clicks" INTEGER NOT NULL DEFAULT 0,
    "search_queries" TEXT[],
    "visitor_cities" INTEGER[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_query_logs" (
    "id" SERIAL NOT NULL,
    "query" TEXT NOT NULL,
    "business_id" INTEGER,
    "category_id" INTEGER,
    "district_id" INTEGER,
    "city_id" INTEGER,
    "result_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_query_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "business_analytics_business_id_idx" ON "business_analytics"("business_id");

-- CreateIndex
CREATE INDEX "business_analytics_date_idx" ON "business_analytics"("date");

-- CreateIndex
CREATE UNIQUE INDEX "business_analytics_business_id_date_key" ON "business_analytics"("business_id", "date");

-- CreateIndex
CREATE INDEX "search_query_logs_query_idx" ON "search_query_logs"("query");

-- CreateIndex
CREATE INDEX "search_query_logs_business_id_idx" ON "search_query_logs"("business_id");

-- CreateIndex
CREATE INDEX "search_query_logs_created_at_idx" ON "search_query_logs"("created_at");

-- AddForeignKey
ALTER TABLE "business_analytics" ADD CONSTRAINT "business_analytics_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
