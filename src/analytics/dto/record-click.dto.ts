import { IsIn, IsInt } from 'class-validator';

export enum AnalyticsClickAction {
  CALL = 'CALL',
  DIRECTION = 'DIRECTION',
  FAVORITE = 'FAVORITE',
  SHARE = 'SHARE',
  WEBSITE = 'WEBSITE',
}

export class RecordClickDto {
  @IsInt()
  businessId: number;

  @IsIn(Object.values(AnalyticsClickAction))
  action: AnalyticsClickAction;
}
