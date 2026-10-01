import { Test } from '@nestjs/testing';
import { OwnerController } from './owner.controller';
import { OwnerService } from './owner.service';

describe('OwnerController.createClaim', () => {
  it('delegates to OwnerService.createClaim with the current user and parsed body', async () => {
    const ownerService = { createClaim: jest.fn().mockResolvedValue({ id: 1 }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [OwnerController],
      providers: [{ provide: OwnerService, useValue: ownerService }],
    }).compile();

    const controller = moduleRef.get(OwnerController);
    const user = { id: 7, phone: '+998901234567', role: 'CUSTOMER' } as any;
    const dto = { businessId: 5 };

    const result = await controller.createClaim(user, dto);

    expect(ownerService.createClaim).toHaveBeenCalledWith(user, dto);
    expect(result).toEqual({ id: 1 });
  });
});
