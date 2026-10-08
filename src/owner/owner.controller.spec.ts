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

describe('OwnerController.resubmitMyBusiness', () => {
  it('delegates to OwnerService.resubmitMyBusiness with the current user id and the listing id', async () => {
    const ownerService = { resubmitMyBusiness: jest.fn().mockResolvedValue({ id: 5, status: 'PENDING' }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [OwnerController],
      providers: [{ provide: OwnerService, useValue: ownerService }],
    }).compile();

    const controller = moduleRef.get(OwnerController);
    const user = { id: 7, phone: '+998901234567', role: 'BUSINESS_OWNER' } as any;

    const result = await controller.resubmitMyBusiness(5, user);

    expect(ownerService.resubmitMyBusiness).toHaveBeenCalledWith(7, 5);
    expect(result).toEqual({ id: 5, status: 'PENDING' });
  });
});
