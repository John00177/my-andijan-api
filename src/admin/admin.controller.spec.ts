import { Test } from '@nestjs/testing';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

describe('AdminController.findReviews', () => {
  it('delegates GET /admin/reviews to AdminService.findReviews with the parsed query', async () => {
    const adminService = { findReviews: jest.fn().mockResolvedValue({ data: [], meta: {} }) };
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: adminService }],
    }).compile();

    const controller = moduleRef.get(AdminController);
    const query = { page: 1, limit: 20 } as any;

    const result = await controller.findReviews(query);

    expect(adminService.findReviews).toHaveBeenCalledWith(query);
    expect(result).toEqual({ data: [], meta: {} });
  });
});
