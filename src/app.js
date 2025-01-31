/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
log4js.configure({
  appenders: {
    vcr: {
      type: "recording",
    },
    out: {
      type: "console",
    },
  },
  categories: { default: { appenders: ["vcr", "out"], level: "info" } },
});

const logger = log4js.getLogger();
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const wxpush = require("./push/wxPusher");
const accounts = require("../accounts");
const retry = require('async-retry'); // 引入重试库

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

// 重试封装函数
const buildTaskResult = (res, result) => {
  const index = result.length;
  if (res.errorCode === "User_Not_Chance") {
    result.push(`第${index}次抽奖失败,次数不足`);
  } else {
    result.push(`第${index}次抽奖成功,抽奖获得${res.prizeName}`);
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 任务 1.签到 2.天天抽红包 3.自动备份抽红包
const doTask = async (cloudClient) => {
  const result = [];

  // 添加重试机制到签到
  const res1 = await retry(async () => {
    return cloudClient.userSign(); // 在此进行重试
  }, {
    retries: 3, // 最大重试次数
    minTimeout: 30000, // 重试间隔 30 秒
    onRetry: (err, attempt) => {
      logger.warn(`签到请求超时，正在进行重试... 第 ${attempt} 次`);
    }
  });

  result.push(
    `${res1.isSign ? "已经签到过了，" : ""}签到获得${res1.netdiskBonus}M空间`
  );
  
  await delay(5000); // 延迟5秒

  return result;
};

// 对家庭任务也增加重试机制
const doFamilyTask = async (cloudClient) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  let totalFamilyBonus = 0;
  const result = [];

  if (familyInfoResp) {
    // 为家庭签到任务添加重试机制
    const res = await retry(async () => {
      return cloudClient.familyUserSign(108508161137369);
    }, {
      retries: 3, // 最大重试次数
      minTimeout: 30000, // 重试间隔 30 秒
      onRetry: (err, attempt) => {
        logger.warn(`家庭签到请求超时，正在进行重试... 第 ${attempt} 次`);
      }
    });

    result.push(
      "家庭任务" +
      `${res.signStatus ? "已经签到过了，" : ""}签到获得${res.bonusSpace}M空间`
    );
    totalFamilyBonus += res.bonusSpace;
  }

  return { result, totalFamilyBonus };
};

// 推送到WxPusher，并添加重试机制
const pushWxPusher = (title, desp) => {
  if (!(wxpush.appToken && wxpush.uid)) {
    return;
  }
  const data = {
    appToken: wxpush.appToken,
    contentType: 1,
    summary: title,
    content: desp,
    uids: [wxpush.uid],
  };

  retry(async () => {
    return superagent
      .post("https://wxpusher.zjiecode.com/api/send/message")
      .send(data)
      .then((res) => {
        const json = JSON.parse(res.text);
        if (json.data[0].code !== 1000) {
          throw new Error(`wxPusher推送失败:${JSON.stringify(json)}`);
        } else {
          logger.info("wxPusher推送成功");
        }
      })
      .catch((err) => {
        throw new Error(`wxPusher推送失败:${JSON.stringify(err)}`);
      });
  }, {
    retries: 3, // 最大重试次数
    minTimeout: 30000, // 重试间隔 30 秒
    onRetry: (err, attempt) => {
      logger.warn(`wxPusher推送失败，正在进行重试... 第 ${attempt} 次`);
    }
  });
};

// 开始执行程序
async function main() {
  let totalFamilySpace = 0;
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    const number = index + 1;
    const { userName, password } = account;
    
    if (userName && password) {
      const userNameInfo = mask(userName, 3, 7);
      try {
        logger.log(`${number}` + ".    " + `账户 ${userNameInfo} 开始执行`);
        const cloudClient = new CloudClient(userName, password);
        
        // 为登录操作添加重试机制
        await retry(async () => {
          await cloudClient.login();
        }, {
          retries: 3,
          minTimeout: 30000, // 重试间隔 30 秒
          onRetry: (err, attempt) => {
            logger.warn(`登录请求超时，正在进行重试... 第 ${attempt} 次`);
          }
        });
        
        // 执行任务
        const result = await doTask(cloudClient);
        result.forEach((r) => logger.log(r));
        
        // 执行家庭任务
        const { result: familyResult, totalFamilyBonus } = await doFamilyTask(cloudClient);
        familyResult.forEach((r) => logger.log(r));
        totalFamilySpace += totalFamilyBonus;

        // 获取并输出云盘容量信息
        const { cloudCapacityInfo, familyCapacityInfo } = await retry(async () => {
          return cloudClient.getUserSizeInfo();
        }, {
          retries: 3,
          minTimeout: 30000, // 重试间隔 30 秒
          onRetry: (err, attempt) => {
            logger.warn(`获取云盘容量请求超时，正在进行重试... 第 ${attempt} 次`);
          }
        });
        
        logger.log(
          `个人：${(cloudCapacityInfo.totalSize / 1024 / 1024 / 1024).toFixed(2)}G, 家庭：${(familyCapacityInfo.totalSize / 1024 / 1024 / 1024).toFixed(2)}G`
        );
      } catch (e) {
        logger.error(e);
        if (e.code === "ETIMEDOUT") {
          throw e;
        }
      } finally {
        logger.log(`账户 ${userNameInfo} 执行完毕----------------`);
      }
    }
  }

  logger.log(`GQQ主账号今天共获得家庭空间：${totalFamilySpace}M`);
  return totalFamilySpace;
}

(async () => {
  try {
    await main();
  } finally {
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
    pushWxPusher("天翼云盘签到任务", content);
    recording.erase();
  }
})();
