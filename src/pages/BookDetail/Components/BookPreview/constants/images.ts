const images = {
    //对应自然拼读1——4，4本书
    "3": Array(192).fill(0).map((_, index) =>
    (
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/1.CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BC-%E5%9B%BE%E7%89%87/CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BCReading%20%26%20Phonics%201_' + (index + 1) + '.png'
    )),
    "4": Array(192).fill(0).map((_, index) =>
    (
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/2.CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BC-%E5%9B%BE%E7%89%87/CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BCReading%20%26%20Phonics%202_' + (index + 1) + '.png'
    )),
    "5": Array(194).fill(0).map((_, index) =>
    (
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/3.CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BC-%E5%9B%BE%E7%89%87/CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BCReading%20%26%20Phonics%203_' + (index + 1) + '.png'
    )),
    "6": Array(196).fill(0).map((_, index) =>
    (
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/4.CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BC-%E5%9B%BE%E7%89%87/CASA%E9%98%85%E8%AF%BB%E4%B8%8E%E8%87%AA%E6%8B%BCReading%20%26%20Phonics%204_' + (index + 1) + '.png'
    )),
}

Object.entries(images).forEach(([_, value]) => {
    value.splice(1, 1);
})

const concatImages = {
    //分别为 PET学生用书、练习册B1 和 KET学生用书、练习册A2，4本书
    "7": Array(210).fill(0).map((_, index) =>
    (
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/PET%E5%AD%A6%E7%94%9F%E7%94%A8%E4%B9%A6/%E3%80%90%E8%AF%BE%E6%9C%AC%E3%80%91%E5%89%91%E6%A1%A5PET%E7%BB%BC%E5%90%88%E6%95%99%E7%A8%8B-%E5%AD%A6%E7%94%9F%E7%94%A8%E4%B9%A6(for%20the%20revised%20exam%20from%202020)._' + (index + 1) + '.png?'
    )),
    "8": Array(80).fill(0).map((_, index) =>
    (
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/PET%E7%BB%83%E4%B9%A0%E5%86%8C/%E3%80%90%E8%AF%BE%E6%9C%AC%E3%80%91%E5%89%91%E6%A1%A5PET%E7%BB%BC%E5%90%88%E6%95%99%E7%A8%8B-%E7%BB%83%E4%B9%A0%E5%86%8C(for%20the%20revised%20exam%20from%202020)._' + (index + 1) + '.png?'
    )),

    "9": Array(189).fill(0).map((_, index) =>
    (
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/KET%E5%AD%A6%E7%94%9F%E7%94%A8%E4%B9%A6/%E5%89%91%E6%A1%A5KET%E7%BB%BC%E5%90%88%E6%95%99%E7%A8%8B%E5%AD%A6%E7%94%9F%E7%94%A8%E4%B9%A6_' + (index + 1) + '.png?'
    )),
    "10": Array(77).fill(0).map((_, index) =>
    (
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/KET%E7%BB%83%E4%B9%A0%E5%86%8C/%E5%89%91%E6%A1%A5KET%E7%BB%BC%E5%90%88%E6%95%99%E7%A8%8B%E7%BB%83%E4%B9%A0%E5%86%8C_' + (index + 1) + '.png?'
    )),
    //1, 2为广告页
    "1": Array(5).fill(0).map((_, index) =>
    (
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/CASA%E6%89%98%E7%A6%8F%E9%9B%85%E6%80%9DSAT%E5%AD%A6%E7%A7%91-1/CASA%E6%89%98%E7%A6%8F%E9%9B%85%E6%80%9DSAT%E5%AD%A6%E7%A7%91(1)_' + (index + 1) + '.png'
    )),
    "2": Array(3).fill(0).map((_, index) =>
    (
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/%E6%B5%B7%E6%B2%99%E8%AF%BE%E7%A8%8B%E6%B5%B7%E6%8A%A5/%E6%B5%B7%E6%B2%99%E8%AF%BE%E7%A8%8B_' + (index + 1) + '.png'

    )),
    //OW 4本书
    //Our World L1 学生用书
    "11": [
        // 封面页
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OW_2E_L1_Studentbook.png',
        // 原有页面
        ...Array(192).fill(0).map((_, index) =>
            'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Our_World_2E_L1_Studentbook-%E5%9B%BE%E7%89%87/OW_2E_L1_Studentbook_' + (index + 1) + '.png'
        )
    ],
    //Our World L1 练习册
    "12": [
        // 封面页
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OW_L1_Workbook.png',
        // 原有页面
        ...Array(127).fill(0).map((_, index) =>
            'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Our_World_2E_L1_Workbook-%E5%9B%BE%E7%89%87/OW_2E_L1_Workbook_' + (index + 1) + '.png?'
        )
    ],
    //Our World Starter 学生用书
    "13": [
        // 封面页
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OW_Starter_Studentbook.png',
        // 原有页面
        ...Array(112).fill(0).map((_, index) =>
            'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Our_World_2E_Starter_Studentbook-%E5%9B%BE%E7%89%87/OW_2E_Starter_Studentbook_' + (index + 1) + '.png'
        )
    ],
    //Our World Starter 练习册
    "14": [
        // 封面页
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/%E5%B0%81%E9%9D%A2%E5%9B%BE%E7%89%87-%E4%B9%A6%E6%9E%B6/OW_Starter_Workbook-1.png',
        // 原有页面
        ...Array(65).fill(0).map((_, index) =>
            'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Our_World_2E_Starter_Workbook-%E5%9B%BE%E7%89%87/OW_2E_Starter_Workbook_' + (index + 1) + '.png'
        )
    ],

    //OD3本书
    //Oxford Discover 1st edition
    "15":[
        ...Array(193).fill(0).map((_, index) =>
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Oxford_Discover__2E_1st-%E5%9B%BE%E7%89%87/OD_2E_L1_' + (index + 1) + '.jpg'
        )
    ],
    //Oxford Discover 2nd edition
    "16":[
        ...Array(193).fill(0).map((_, index) =>
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Oxford_Discover__2E_2nd-%E5%9B%BE%E7%89%87/OD_2E_L2_' + (index + 1) + '.jpg?'
        )
    ],
    //Oxford Discover 3rd edition
    "17":[
        ...Array(194).fill(0).map((_, index) =>
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Oxford_Discover__2E_3rd-%E5%9B%BE%E7%89%87/OD_2E_L3_' + (index + 1) + '.jpg?'
        )
    ], 
    //Oxford Discover 4th edition
    "18":[
        ...Array(194).fill(0).map((_, index) =>
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Oxford_Discover__2E_4th-%E5%9B%BE%E7%89%87/OD_4_' + (index + 1) + '.jpg'
        )
    ],
    //Reading Explorer L1 学生用书
    "19":[
        ...Array(177).fill(0).map((_, index) =>
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Reading_Explorer_L1_Studentbook-%E5%9B%BE%E7%89%87/ReadingExplorer_L1_Studentbook_' + (index + 1) + '.jpg'
        )
    ],
    //Reading Explorer L2 学生用书
    "20":[
        ...Array(193).fill(0).map((_, index) =>
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Reading_Explorer_L2_Studentbook-%E5%9B%BE%E7%89%87/ReadingExplorer_L2_Studentbook_' + (index + 1) + '.jpg'
        )
    ],
    //Reading_Explorer_fundation_studentbook
    "21":[
        ...Array(177).fill(0).map((_, index) =>
        'https://636c-cloud1-6geu18jg425a604e-1360744728.tcb.qcloud.la/Reading_Explorer_Foundations_Studentbook-%E5%9B%BE%E7%89%87/ReadingExplorer_Foundations_Studentbook_' + (index + 1) + '.jpg'
        )
    ],
    ...images,
}
export { concatImages };
