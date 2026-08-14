-- CreateTable
CREATE TABLE "platform_metrics" (
    "id" SERIAL NOT NULL,
    "metric_type" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "value" INTEGER NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_analytics" (
    "id" SERIAL NOT NULL,
    "query" TEXT NOT NULL,
    "result_count" INTEGER NOT NULL,
    "click_count" INTEGER NOT NULL DEFAULT 0,
    "business_id" INTEGER,
    "district_id" INTEGER,
    "category_id" INTEGER,
    "city_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "search_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" SERIAL NOT NULL,
    "action_type" TEXT NOT NULL,
    "user_id" INTEGER,
    "business_id" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_metrics_metric_type_date_idx" ON "platform_metrics"("metric_type", "date");

-- CreateIndex
CREATE UNIQUE INDEX "platform_metrics_metric_type_date_key" ON "platform_metrics"("metric_type", "date");

-- CreateIndex
CREATE INDEX "search_analytics_query_idx" ON "search_analytics"("query");

-- CreateIndex
CREATE INDEX "search_analytics_created_at_idx" ON "search_analytics"("created_at");

-- CreateIndex
CREATE INDEX "activity_logs_action_type_created_at_idx" ON "activity_logs"("action_type", "created_at");

-- CreateIndex
CREATE INDEX "activity_logs_business_id_idx" ON "activity_logs"("business_id");

-- CreateIndex
CREATE INDEX "activity_logs_user_id_idx" ON "activity_logs"("user_id");
