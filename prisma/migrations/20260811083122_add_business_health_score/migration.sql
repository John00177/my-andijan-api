-- CreateTable
CREATE TABLE "business_health_scores" (
    "id" SERIAL NOT NULL,
    "business_id" INTEGER NOT NULL,
    "overall_score" INTEGER NOT NULL,
    "profile_score" INTEGER NOT NULL,
    "engagement_score" INTEGER NOT NULL,
    "visibility_score" INTEGER NOT NULL,
    "response_score" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_calculated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_health_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_recommendations" (
    "id" SERIAL NOT NULL,
    "health_score_id" INTEGER NOT NULL,
    "code" VARCHAR(60) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "priority" VARCHAR(10) NOT NULL,
    "title_uz" VARCHAR(200) NOT NULL,
    "title_ru" VARCHAR(200) NOT NULL,
    "title_en" VARCHAR(200) NOT NULL,
    "description_uz" TEXT NOT NULL,
    "description_ru" TEXT NOT NULL,
    "description_en" TEXT NOT NULL,
    "action_text_uz" VARCHAR(120) NOT NULL,
    "action_text_ru" VARCHAR(120) NOT NULL,
    "action_text_en" VARCHAR(120) NOT NULL,
    "action_url" VARCHAR(500),
    "impact_uz" VARCHAR(120) NOT NULL,
    "impact_ru" VARCHAR(120) NOT NULL,
    "impact_en" VARCHAR(120) NOT NULL,
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_health_scores_business_id_key" ON "business_health_scores"("business_id");

-- CreateIndex
CREATE INDEX "business_health_scores_overall_score_idx" ON "business_health_scores"("overall_score");

-- CreateIndex
CREATE INDEX "business_recommendations_health_score_id_is_completed_idx" ON "business_recommendations"("health_score_id", "is_completed");

-- CreateIndex
CREATE UNIQUE INDEX "business_recommendations_health_score_id_code_key" ON "business_recommendations"("health_score_id", "code");

-- AddForeignKey
ALTER TABLE "business_health_scores" ADD CONSTRAINT "business_health_scores_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_recommendations" ADD CONSTRAINT "business_recommendations_health_score_id_fkey" FOREIGN KEY ("health_score_id") REFERENCES "business_health_scores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
