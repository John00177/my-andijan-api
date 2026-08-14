import { IsInt, IsOptional } from 'class-validator';

export class RecordViewDto {
  @IsInt()
  businessId: number;

  // From IP/geography — optional since it isn't always resolvable.
  @IsOptional()
  @IsInt()
  cityId?: number;
}
