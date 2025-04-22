import {
  AdjustData,
  CoupangComparisonWithOnchData,
  CoupangInvoice,
  JobType,
  InvoiceUploadResult,
  OnchWithCoupangProduct,
  CoupangPagingProduct,
} from '@daechanjo/models';
import { RabbitMQService } from '@daechanjo/rabbitmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as XLSX from 'xlsx';

import { CoupangApiService } from './coupang.api.service';
import { CoupangSignatureService } from './coupang.signature.service';
import { CoupangUpdateItemEntity } from '../infrastructure/entities/coupangUpdateItem.entity';
import { CoupangRepository } from '../infrastructure/repository/coupang.repository';

@Injectable()
export class CoupangService {
  constructor(
    private readonly configService: ConfigService,
    private readonly signatureService: CoupangSignatureService,
    private readonly coupangRepository: CoupangRepository,
    private readonly rabbitmqService: RabbitMQService,
    private readonly coupangApiService: CoupangApiService,
  ) {}

  /**
   * 판매자 상품 ID를 기반으로 쿠팡 상품의 판매를 중지하는 메서드
   *
   * @param jobId - 작업 식별을 위한 고유 ID
   * @param jobType - 작업 유형 (예: 'SOLDOUT')
   * @param data - 판매 중지할 상품 데이터 배열
   *               OnchWithCoupangProduct[] 또는 CoupangComparisonWithOnchData[] 타입
   *
   * @returns {Promise<{status: string}>} 작업 성공 시 {status: 'success'} 객체를 반환하는 Promise
   *
   * @description
   * 1. 주어진.data 배열의 각 상품에 대해 상세 정보를 조회
   * 2. 조회된 상세 정보의 모든 아이템에 대해 판매 중지 처리
   * 3. 처리 진행상황을 10% 단위로 로그에 출력
   * 4. API 호출 간 0.5초 간격으로 요청 제한
   */
  async stopSaleBySellerProductId(
    jobId: string,
    jobType: string,
    data: { sellerProductId: string; productName: string }[],
  ): Promise<{ status: string }> {
    console.log(`${jobType}${jobId}: 쿠팡 아이템 판매 중지 시작`);
    if (data.length === 0) {
      console.warn(`${jobType}${jobId}: 중지할 아이템이 없습니다`);
    }
    const detailedProducts = [];

    for (const [i, product] of data.entries()) {
      if (i % Math.ceil(data.length / 10) === 0) {
        const progressPercentage = ((i + 1) / data.length) * 100;
        console.log(
          `${jobType}${jobId}: 중지 상품 상세조회중 ${i + 1}/${data.length} (${progressPercentage.toFixed(2)}%)`,
        );
      }

      const details = await this.coupangApiService.getProductDetail(
        jobId,
        jobType,
        product.sellerProductId,
      );
      detailedProducts.push(details);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    for (const [i, productDetail] of detailedProducts.entries()) {
      if (i % Math.ceil(detailedProducts.length / 10) === 0) {
        const progressPercentage = ((i + 1) / detailedProducts.length) * 100;
        console.log(
          `${jobType}${jobId}: 아이템 중지중 ${i + 1}/${detailedProducts.length} (${progressPercentage.toFixed(2)}%)`,
        );
      }

      if (productDetail && productDetail.items) {
        const items = productDetail.items;

        for (const item of items) {
          await this.coupangApiService.putStopSellingItem(jobId, jobType, item.vendorItemId);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }

    return { status: 'success' };
  }

  /**
   * 쿠팡 상품을 일괄 삭제하는 메서드
   *
   * @param jobId - 작업 식별을 위한 고유 ID
   * @param jobType - 작업 유형 (예: 'SOLDOUT')
   * @param data - 삭제할 상품 데이터 배열
   *               CoupangPagingProduct[] 또는 CoupangComparisonWithOnchData[] 타입
   *
   * @returns {Promise<void>} 작업 완료 후 아무 값도 반환하지 않는 Promise
   *
   * @description
   * 1. 주어진 data 배열의 각 상품을 순차적으로 삭제
   * 2. 처리 진행상황을 10% 단위로 로그에 출력
   * 3. 삭제된 상품 정보를 수집하여 이메일 발송 큐에 메시지 전송
   * 4. API 호출 간 0.5초 간격으로 요청 제한
   * 5. 에러 발생 시 로그 기록 후 계속 진행
   */
  async deleteProducts(
    jobId: string,
    jobType: string,
    data: { sellerProductId: string; productName: string }[],
  ): Promise<void> {
    console.log(`${jobType}${jobId}: 쿠팡 상품 삭제 시작`);
    if (data.length === 0) {
      console.warn(`${jobType}${jobId}: 삭제할 상품이 없습니다`);
      return;
    }

    const deletedProducts: { sellerProductId: string; productName: string }[] = [];

    for (const [i, product] of data.entries()) {
      if (i % Math.ceil(data.length / 10) === 0) {
        const progressPercentage = ((i + 1) / data.length) * 100;
        console.log(
          `${jobType}${jobId}: 아이템 삭제중 ${i + 1}/${data.length} (${progressPercentage.toFixed(2)}%)`,
        );
      }

      try {
        await this.coupangApiService.deleteProduct(product.sellerProductId);

        deletedProducts.push({
          sellerProductId: product.sellerProductId,
          productName: product.productName,
        });

        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error: any) {
        console.error(
          `${JobType.ERROR}${jobType}${jobId}: 쿠팡 상품 삭제 실패-${product.sellerProductId})\n`,
          error.response?.data || error.message,
        );
      }
    }

    if (deletedProducts.length > 0) {
      try {
        await this.rabbitmqService.emit('mail-queue', 'sendBatchDeletionEmail', {
          jobId: jobId,
          jobType: jobType,
          jobName: '쿠팡 상품 삭제 안내',
          data: deletedProducts,
        });
      } catch (error: any) {
        console.error(
          `${JobType.ERROR}${jobType}${jobId}: 삭제 알림 이메일 발송 실패\n`,
          error.response?.data || error.message,
        );
      }
    }
  }

  /**
   * 쿠팡 상품의 가격을 일괄 업데이트하는 메서드
   *
   * @param jobId - 작업 식별을 위한 고유 ID
   * @param jobType - 작업 유형
   *
   * @returns {Promise<void>} 작업 완료 후 아무 값도 반환하지 않는 Promise
   *
   * @description
   * 1. 데이터베이스에서 업데이트가 필요한 상품 정보를 조회
   * 2. 각 상품의 가격을 쿠팡 API를 통해 업데이트
   * 3. 처리 진행상황을 10% 단위로 로그에 출력
   * 4. 업데이트 결과를 Excel 파일로 생성
   * 5. 생성된 Excel 파일을 이메일 발송 큐에 메시지 전송
   * 6. API 호출 간 0.1초 간격으로 요청 제한
   * 7. 에러 발생 시 로그 기록 후 계속 진행
   */
  async coupangProductsPriceControl(jobId: string, jobType: string): Promise<void> {
    console.log(`${jobType}${jobId}: 새로운 상품 가격 업데이트 시작`);

    let successCount = 0;
    let failedCount = 0;

    const updatedItems = await this.coupangRepository.getUpdatedItems(jobId);

    if (updatedItems.length === 0) {
      console.log(`${jobType}${jobId}: 새로운 업데이트가 없습니다. 종료합니다.`);
      return;
    }

    console.log(`${jobType}${jobId}: 총 ${updatedItems.length}개의 아이템 업데이트`);

    for (const [i, item] of updatedItems.entries()) {
      if (i % Math.ceil(updatedItems.length / 10) === 0) {
        const progressPercentage = ((i + 1) / updatedItems.length) * 100;
        console.log(
          `${jobType}${jobId}: 가격 업데이트중 ${i + 1}/${updatedItems.length} (${progressPercentage.toFixed(2)}%)`,
        );
      }

      const vendorItemId = item.vendorItemId;

      const priceUpdatePath = `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/prices/${item.newPrice}`;

      const { authorization, datetime } = await this.signatureService.createHmacSignature(
        'PUT',
        priceUpdatePath,
        '',
        false,
      );

      try {
        await axios.put(`https://api-gateway.coupang.com${priceUpdatePath}`, null, {
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json;charset=UTF-8',
            'X-Coupang-Date': datetime,
          },
        });

        successCount++;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error: any) {
        failedCount++;
        console.error(
          `${JobType.ERROR}${jobType}${jobId}: 가격 업데이트 오류-${vendorItemId}\n`,
          error.response?.data || error.message,
        );
      }
    }

    console.log(`${jobType}${jobId}: 엑셀 생성 시작`);
    setImmediate(async () => {
      try {
        const excelData = updatedItems.map((item: CoupangUpdateItemEntity) => ({
          'Vendor Item ID': item.vendorItemId,
          'Product Name': item.productName,
          'Winner Price': item.winnerPrice,
          'Current Price': item.currentPrice,
          'Seller Price': item.sellerPrice,
          'New Price': item.newPrice,
        }));

        const worksheet = XLSX.utils.json_to_sheet(excelData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, 'UpdatedProducts');
        const filePath = '/Users/daechanjo/codes/project/auto-store/tmp/coupang_' + jobId + '.xlsx';

        XLSX.writeFile(workbook, filePath);

        console.log(`${jobType}${jobId}: 엑셀 파일 전송 요청`);
        await this.rabbitmqService.emit('mail-queue', 'sendUpdateEmail', {
          jobId: jobId,
          jobType: jobType,
          jobName: '쿠팡 가격 업데이트',
          data: { filePath: filePath, successCount: successCount, failedCount: failedCount },
        });

        console.log(`${jobType}${jobId}: 엑셀 파일 전송 요청 완료`);
      } catch (error: any) {
        console.error(
          `${JobType.ERROR}${jobType}${jobId}: 메시지 전송 실패\n`,
          error.response?.data || error.message,
        );
      }
    });

    console.log(`${jobType}${jobId}: 상품 가격 업데이트 완료`);
  }

  /**
   * 쿠팡 상품의 배송비 정보를 일괄 관리하는 메서드
   *
   * @param jobId - 작업 식별을 위한 고유 ID
   * @param jobType - 작업 유형
   * @param coupangProductDetails - 배송비 정보를 업데이트할 쿠팡 상품 상세 정보 배열
   *
   * @returns {Promise<{successCount: number, failedCount: number}>} 작업 성공 및 실패 건수 정보를 담은 객체
   *
   * @description
   * 1. 주어진 상품 정보 배열의 각 상품에 대해 배송비 정보 업데이트
   * 2. 성공 및 실패 건수 집계
   * 3. API 호출 간 0.3초 간격으로 요청 제한
   * 4. 에러 발생 시 로그 기록 후 계속 진행
   */
  async shippingCostManagement(
    jobId: string,
    jobType: string,
    coupangProductDetails: any,
  ): Promise<{ successCount: number; failedCount: number }> {
    let successCount = 0;
    let failedCount = 0;

    console.log(`${jobType}${jobId}: ${coupangProductDetails.length}개 수정 시작...`);

    for (const product of coupangProductDetails) {
      try {
        await this.coupangApiService.putUpdateProduct(product);

        successCount++;
      } catch (error: any) {
        console.error(
          `${JobType.ERROR}${jobType}${jobId}: 반품 배송비 업데이트 실패-${product.sellerProductId}\n`,
          error.response?.data || error.message,
        );
        failedCount++;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    return { successCount: successCount, failedCount: failedCount };
  }

  /**
   * 쿠팡 비교 데이터를 초기화하는 메서드
   *
   * @returns {Promise<void>} 작업 완료 후 아무 값도 반환하지 않는 Promise
   *
   * @description
   * 데이터베이스에 저장된 쿠팡 상품 비교 정보를 모두 삭제
   */
  async clearCoupangComparison(): Promise<void> {
    await this.coupangRepository.clearCoupangComparison();
  }

  /**
   * 업데이트된 쿠팡 상품 정보를.데이터베이스에 저장하는 메서드
   *
   * @param jobId - 작업 식별을 위한 고유 ID
   * @param jobType - 작업 유형
   * @param items - 저장할 업데이트된 상품 정보 배열 (AdjustData[] 타입)
   *
   * @returns {Promise<void>} 작업 완료 후 아무 값도 반환하지 않는 Promise
   *
   * @description
   * 업데이트된 쿠팡 상품 정보를 데이터베이스에 저장
   */
  async saveUpdateCoupangItems(jobId: string, jobType: string, items: AdjustData[]): Promise<void> {
    await this.coupangRepository.saveUpdatedCoupangItems(items, jobId);
  }

  /**
   * 쿠팡 상품 비교 데이터의 총 개수를 조회하는 메서드
   *
   * @returns {Promise<number>} 비교 데이터 개수를 반환하는 Promise
   *
   * @description
   * 데이터베이스에 저장된 쿠팡 상품 비교 정보의 총 개수를 조회하여 반환
   */
  async getComparisonCount(): Promise<number> {
    return this.coupangRepository.getComparisonCount();
  }

  /**
   * 쿠팡 송장 정보를 순차적으로 업로드합니다.
   * @param jobId 크론 작업 ID
   * @param jobType 작업 유형
   * @param invoices 업로드할 송장 목록
   */
  async uploadInvoices(
    jobId: string,
    jobType: string,
    invoices: CoupangInvoice[],
  ): Promise<InvoiceUploadResult[]> {
    const results: InvoiceUploadResult[] = [];

    for (const invoice of invoices) {
      const result: InvoiceUploadResult = {
        orderId: invoice.orderId,
        status: 'failed', // 기본값은 실패로 설정
        courierName: invoice.courier.courier,
        trackingNumber: invoice.courier.trackNumber,
        name: invoice.courier.nameText,
        safeNumber: invoice.courier.phoneText,
        error: '',
      };

      try {
        // 송장 업로드 시도
        await this.coupangApiService.uploadInvoice(jobId, jobType, invoice);

        // 성공 시 상태 업데이트
        result.status = 'success';
      } catch (error: any) {
        // 오류 메시지 저장
        result.error = error.message || '알 수 없는 오류';
        console.error(
          `${jobType}${jobId}: 주문 ${invoice.orderId} 송장 업로드 실패\n`,
          error.response?.data || error.message,
        );
      }

      // 결과 배열에 추가
      results.push(result);

      // 요청 간 간격 두기
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return results;
  }
}
