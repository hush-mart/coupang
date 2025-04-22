import { CoupangInvoice, CoupangProduct, JobType } from '@daechanjo/models';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosResponse } from 'axios';

import { CoupangSignatureService } from './coupang.signature.service';

@Injectable()
export class CoupangApiService {
  constructor(
    private readonly signatureService: CoupangSignatureService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * 쿠팡 판매자 API를 통해 전체 상품 목록을 페이징하여 조회
   *
   * @param jobId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param jobType - 로그 메시지에 포함될 작업 유형 식별자
   *
   * @returns {Promise<CoupangProduct[]>} - 쿠팡 상품 객체 배열을 포함하는 Promise
   *
   * @throws {Error} - API 요청 실패 시 발생하는 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 쿠팡 판매자 API에 페이징 방식으로 상품 조회 요청
   * 2. nextToken을 사용하여 모든 페이지를 순차적으로 조회
   * 3. 각 페이지에서 받은 상품 데이터를 누적하여 저장
   * 4. API 오류 발생 시 최대 3회까지 재시도
   * 5. 모든 페이지 조회 완료 후 전체 상품 목록 반환
   *
   * API 요청 중 오류가 발생하면 로그를 남기고 재시도하며,
   * 최대 재시도 횟수를 초과하면 예외를 발생시킵니다.
   * 페이지 진행 상황을 10페이지마다 로그로 기록합니다.
   */
  async getProductListPaging(jobId: string, jobType: string): Promise<CoupangProduct[]> {
    console.log(`${jobType}${jobId}: 쿠팡 전체상품 조회...`);
    const apiPath = '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products';

    let nextToken = '';
    let pageCount = 0;
    const allProducts: CoupangProduct[] = [];
    const maxRetries = 3; // 최대 재시도 횟수

    try {
      while (true) {
        let retryCount = 0;

        while (retryCount < maxRetries) {
          try {
            const { authorization, datetime } = await this.signatureService.createHmacSignature(
              'GET',
              apiPath,
              nextToken,
              true,
            );

            await new Promise((resolve) => setTimeout(resolve, 1000));

            const response = await axios.get(`https://api-gateway.coupang.com${apiPath}`, {
              headers: {
                Authorization: authorization,
                'Content-Type': 'application/json;charset=UTF-8',
                'X-EXTENDED-TIMEOUT': '90000',
                'X-Coupang-Date': datetime,
              },
              params: {
                vendorId: this.configService.get<string>('COUPANG_VENDOR_ID'),
                nextToken: nextToken,
                maxPerPage: 100,
                status: 'APPROVED',
              },
            });

            const { data } = response.data;
            allProducts.push(...data);

            nextToken = response.data.nextToken;
            pageCount++;

            if (pageCount % 10 === 0)
              console.log(
                `${jobType}${jobId}: 진행중 - 현재 페이지 ${pageCount}, ${allProducts.length} 수집됨`,
              );

            if (!nextToken) {
              // nextToken이 없으면 마지막 페이지이므로 종료
              break;
            }

            // 성공 시 재시도 루프 종료
            break;
          } catch (error: any) {
            retryCount++;
            console.error(
              `${JobType.ERROR}${jobType}${jobId}: API 요청 오류, 재시도 ${retryCount}/${maxRetries}\n`,
              error.response?.data || error.message,
            );

            // 재시도 횟수 초과 시 throw
            if (retryCount >= maxRetries) {
              throw new Error(
                `${JobType.ERROR}${jobType}${jobId}: 최대 재시도 횟수를 초과하여 요청 실패 (nextToken: ${nextToken || '없음'})`,
              );
            }

            // 짧은 대기 후 재시도
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }

        // 다음 페이지로 이동
        if (!nextToken) break;
      }

      console.log(`${jobType}${jobId}: 쿠팡 전체상품 조회 완료 - ${allProducts.length}개`);

      return allProducts;
    } catch (error: any) {
      console.error(
        `${JobType.ERROR}${jobType}${jobId}: API 요청 중단\n`,
        error.response?.data || error.message,
      );
      throw new Error('쿠팡 API 요청 실패');
    }
  }

  /**
   * 쿠팡 판매자 API를 통해 특정 상품의 상세 정보 조회
   *
   * @param jobId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param jobType - 로그 메시지에 포함될 작업 유형 식별자
   * @param sellerProductId - 조회할 판매자 상품 ID
   *
   * @returns {Promise<CoupangProduct>} - 상품 상세 정보를 포함하는 Promise
   *
   * @throws {Error} - API 요청 실패 시 발생하는 오류
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 상품 ID를 기반으로 쿠팡 API 경로 구성
   * 2. HMAC 서명 생성
   * 3. API 요청 헤더에 인증 정보와 타임스탬프 추가
   * 4. 쿠팡 API를 통해 상품 상세 정보 요청
   * 5. 응답에서 data 필드 추출하여 반환
   *
   * API 요청 중 오류가 발생하면 로그를 남기고 예외를 발생시킵니다.
   */
  async getProductDetail(
    jobId: string,
    jobType: string,
    sellerProductId: string | number,
  ): Promise<CoupangProduct> {
    const apiPath = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`;

    const { authorization, datetime } = await this.signatureService.createHmacSignature(
      'GET',
      apiPath,
      '',
      false,
    );

    try {
      const response = await axios.get(`https://api-gateway.coupang.com${apiPath}`, {
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json;charset=UTF-8',
          'X-EXTENDED-TIMEOUT': '90000',
          'X-Coupang-Date': datetime,
        },
      });

      return response.data.data;
    } catch (error: any) {
      console.error(
        `${JobType.ERROR}${jobType}${jobId}: 상품 상세 조회 오류 ${sellerProductId}\n`,
        error.response?.data || error.message,
      );
      throw new Error('쿠팡 상품 상세 조회 실패');
    }
  }

  /**
   * 쿠팡 판매자 API를 통해 특정 상품의 판매를 중지
   *
   * @param jobId - 현재 실행 중인 크론 작업의 고유 식별자
   * @param jobType - 로그 메시지에 포함될 작업 유형 식별자
   * @param vendorItemId - 판매 중지할 판매자 상품 항목 ID
   *
   * @returns {Promise<void>} - 작업 완료 후 반환되는 Promise
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 상품 항목 ID를 기반으로 쿠팡 API 경로 구성
   * 2. PUT 메서드를 위한 HMAC 서명 생성
   * 3. API 요청 헤더에 인증 정보와 타임스탬프 추가
   * 4. 쿠팡 API를 통해 판매 중지 요청 실행
   *
   * API 요청 중 오류가 발생하면 로그를 남기지만 예외를 발생시키지 않고 계속 진행합니다.
   * 이는 일부 상품 판매 중지 실패가 전체 프로세스를 중단시키지 않도록 하기 위함입니다.
   */
  async putStopSellingItem(jobId: string, jobType: string, vendorItemId: number): Promise<void> {
    const apiPath = `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vendorItemId}/sales/stop`;

    const { authorization, datetime } = await this.signatureService.createHmacSignature(
      'PUT',
      apiPath,
      '',
      false,
    );

    try {
      await axios.put(`https://api-gateway.coupang.com${apiPath}`, null, {
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json;charset=UTF-8',
          'X-EXTENDED-TIMEOUT': '90000',
          'X-Coupang-Date': datetime,
        },
      });
    } catch (error: any) {
      console.error(
        `${JobType.ERROR}${jobType}${jobId}: 아이템 판매 중지 실패 ${vendorItemId}\n`,
        error.response?.data || error.message,
      );
    }
  }

  /**
   * 쿠팡 판매자 API를 통해 상품을 삭제
   *
   * @param sellerProductId - 삭제할 상품 sellerProductId
   *
   * @returns {Promise<AxiosResponse>} - API 응답을 포함하는 Promise
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 상품 ID를 기반으로 쿠팡 API 경로 구성
   * 2. DELETE 메서드를 위한 HMAC 서명 생성
   * 3. API 요청 헤더에 인증 정보와 타임스탬프 추가
   * 4. 쿠팡 API를 통해 상품 삭제 요청 실행
   * 5. 요청의 응답을 그대로 반환
   *
   * 이 메서드는 오류를 캐치하지 않고 호출자에게 전달합니다.
   * 따라서 호출자는 API 응답을 처리하거나 오류를 적절히 처리해야 합니다.
   */
  async deleteProduct(sellerProductId: string | number): Promise<AxiosResponse> {
    const apiPath = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${sellerProductId}`;
    const { authorization, datetime } = await this.signatureService.createHmacSignature(
      'DELETE',
      apiPath,
      '',
      false,
    );

    return axios.delete(`https://api-gateway.coupang.com${apiPath}`, {
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json;charset=UTF-8',
        'X-EXTENDED-TIMEOUT': '90000',
        'X-Coupang-Date': datetime,
      },
    });
  }

  /**
   * 쿠팡 판매자 API를 통해 상품 정보를 부분 업데이트하는 메서드
   *
   * @param product - 업데이트할 상품 객체 (sellerProductId를 포함해야 함)
   *
   * @returns {Promise<void>} - 작업 완료 후 반환되는 Promise
   *
   * @description
   * 이 메서드는 다음 단계로 진행됩니다:
   * 1. 상품 ID를 기반으로 쿠팡 API 경로 구성 (부분 업데이트용 경로 사용)
   * 2. 업데이트할 데이터 (sellerProductId와 반품 비용)를 포함하는 요청 본문 구성
   * 3. PUT 메서드를 위한 HMAC 서명 생성
   * 4. API 요청 헤더에 인증 정보와 타임스탬프 추가
   * 5. 쿠팡 API를 통해 상품 부분 업데이트 요청 실행
   *
   * 현재 구현에서는 반품 비용(returnCharge)을 5000원으로 고정하여 업데이트합니다.
   * 이 메서드는 오류를 캐치하지 않고 호출자에게 전달합니다.
   */
  async putUpdateProduct(product: any): Promise<void> {
    const updatePath = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${product.sellerProductId}/partial`;
    const body = { sellerProductId: product.sellerProductId, returnCharge: 5000 };

    const { authorization, datetime } = await this.signatureService.createHmacSignature(
      'PUT',
      updatePath,
      '',
      false,
    );

    await axios.put(`https://api-gateway.coupang.com${updatePath}`, body, {
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json;charset=UTF-8',
        'X-Coupang-Date': datetime,
      },
    });
  }

  async putOrderStatus(jobId: string, jobType: string, shipmentBoxIds: string[]): Promise<void> {
    console.log(`${jobType}${jobId}: 주문 상태 변경`);
    const vendorId = this.configService.get<string>('COUPANG_VENDOR_ID');
    const updatePath = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets/acknowledgement`;
    const body = { vendorId: vendorId, shipmentBoxIds: shipmentBoxIds };

    const { authorization, datetime } = await this.signatureService.createHmacSignature(
      'PUT',
      updatePath,
      '',
      false,
    );

    try {
      const result = await axios.put(`https://api-gateway.coupang.com${updatePath}`, body, {
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json;charset=UTF-8',
          'X-Coupang-Date': datetime,
        },
      });
      console.log(JSON.stringify(result.data, null, 2));
    } catch (error: any) {
      console.error(`${JobType.ERROR}${jobType}${jobId}: 변경 실패\n`, error);
    }
  }

  /**
   * 단일 송장을 업로드하고 지정된 시간만큼 대기합니다.
   * @param jobId 크론 작업 ID
   * @param jobType 작업 유형
   * @param invoice 업로드할 송장 정보
   */
  async uploadInvoice(jobId: string, jobType: string, invoice: CoupangInvoice) {
    const vendorId = this.configService.get<string>('COUPANG_VENDOR_ID');
    const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/orders/invoices`;
    const body = {
      vendorId: vendorId,
      orderSheetInvoiceApplyDtos: [
        {
          shipmentBoxId: invoice.shipmentBoxId,
          orderId: invoice.orderId,
          deliveryCompanyCode: invoice.deliveryCompanyCode,
          invoiceNumber: invoice.courier.trackNumber,
          vendorItemId: invoice.items[0].vendorItemId,
          splitShipping: false,
          preSplitShipped: false,
          estimatedShippingDate: '',
        },
      ],
    };

    const { authorization, datetime } = await this.signatureService.createHmacSignature(
      'POST',
      path,
      '',
      false,
    );

    try {
      const result = await axios.post(`https://api-gateway.coupang.com${path}`, body, {
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json;charset=UTF-8',
          'X-Coupang-Date': datetime,
        },
      });

      if (result.data.data.responseMessage === 'FAIL') throw new Error(result.data);
    } catch (error: any) {
      console.error(`${JobType.ERROR}${jobType}${jobId}: 실패\n`, error);
      throw new Error(error);
    }
  }

  /**
   * 쿠팡의 특정 주문 정보를 조회하는 메서드
   *
   * @returns {Promise<void>} - 작업이 완료되면 resolve되는 Promise
   *
   * @remarks
   * 쿠팡 오픈 API를 사용하여 하드코딩된 주문번호(미정)의 정보를 조회합니다.
   * HMAC 서명을 생성하여 인증 헤더와 함께 GET 요청을 전송합니다.
   * 응답 데이터는 콘솔에 출력됩니다.
   *
   * @example
   * // 하드코딩된 주문번호의 주문 정보 조회하기
   * await getOrder();
   *
   */
  async getOrder() {
    const vendorId = this.configService.get<string>('COUPANG_VENDOR_ID');
    const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/25100104633733/ordersheets`;

    const { authorization, datetime } = await this.signatureService.createHmacSignature(
      'GET',
      path,
      '',
      false,
    );

    const result = await axios.get(`https://api-gateway.coupang.com${path}`, {
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json;charset=UTF-8',
        'X-Coupang-Date': datetime,
      },
    });
    console.log(JSON.stringify(result.data, null, 2));
  }

  /**
   * 쿠팡 판매자 상품의 유입 상태를 조회하는 메서드
   *
   * @returns {Promise<void>} - 작업이 완료되면 resolve되는 Promise
   *
   * @remarks
   * 쿠팡 셀러 API를 사용하여 판매자의 상품 유입 상태를 조회합니다.
   * HMAC 서명을 생성하여 인증 헤더와 함께 GET 요청을 전송합니다.
   * 응답 데이터는 콘솔에 출력됩니다.
   *
   * @todo 페이지네이션이나 필터링 파라미터를 추가하는 것이 좋을 수 있습니다.
   */
  async getProductInflow(): Promise<void> {
    const path = `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/inflow-status`;

    const { authorization, datetime } = await this.signatureService.createHmacSignature(
      'GET',
      path,
      '',
      false,
    );

    const result = await axios.get(`https://api-gateway.coupang.com${path}`, {
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json;charset=UTF-8',
        'X-Coupang-Date': datetime,
      },
    });
    console.log(JSON.stringify(result.data, null, 2));
  }
}
