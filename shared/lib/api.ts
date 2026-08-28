// @ts-nocheck
import { supabase } from '@shared/supabase/client';

// ===== 프로필 관련 API =====
export const profileApi = {
  // 현재 사용자 프로필 조회
  getCurrentProfile: async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) throw error;
    return data;
  },

  // 모든 프로필 조회 (선생님용)
  getAllProfiles: async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // 프로필 업데이트
  updateProfile: async (updates) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('사용자가 로그인되지 않았습니다.');

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('user_id', user.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }
};

// ===== 교재 관련 API =====
export const textbookApi = {
  getTextbooks: async () => {
    const { data, error } = await supabase
      .from('textbooks')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  },

  getTextbooksWithHierarchy: async () => {
    const { data: textbooks, error: tbError } = await supabase
      .from('textbooks')
      .select('*')
      .order('name', { ascending: true });
    if (tbError) throw tbError;

    const { data: chapters, error: chError } = await supabase
      .from('chapters')
      .select('*')
      .order('sort_order', { ascending: true });
    if (chError) throw chError;

    const { data: subchapters, error: scError } = await supabase
      .from('subchapters')
      .select('*')
      .order('sort_order', { ascending: true });
    if (scError) throw scError;

    return (textbooks || []).map(tb => ({
      ...tb,
      chapters: (chapters || [])
        .filter(ch => ch.textbook_id === tb.id)
        .map(ch => ({
          ...ch,
          subchapters: (subchapters || []).filter(sc => sc.chapter_id === ch.id)
        }))
    }));
  },

  getChaptersByTextbook: async (textbookId) => {
    const { data, error } = await supabase
      .from('chapters')
      .select('*')
      .eq('textbook_id', textbookId)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  getSubchaptersByChapter: async (chapterId) => {
    const { data, error } = await supabase
      .from('subchapters')
      .select('*')
      .eq('chapter_id', chapterId)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  getTextbookProblemCounts: async (textbookId) => {
    const { data, error, count } = await supabase
      .from('problems')
      .select('id', { count: 'exact', head: true })
      .eq('textbook_id', textbookId);
    if (error) throw error;
    return count || 0;
  },
};

// ===== 문제 관련 API =====
export const problemApi = {
  // 문제 목록 조회 (현재 선생님의 문제만, 교재 필터 옵션)
  // folderId: 027 통합 폴더(problem_folders). 하위 폴더 문제까지 포함한다(CMS 와 동작 일치).
  // chapterId/subchapterId 는 옛 구조 — 신규 코드는 folderId 를 쓴다.
  getProblems: async (teacherId, filters?: { textbookId?: string; chapterId?: string; subchapterId?: string; folderId?: string; folderIds?: string[] }) => {
    let query = supabase
      .from('problems')
      .select('*')
      .order('problem_number', { ascending: true });

    if (teacherId) {
      if (teacherId.length === 36) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('user_id', teacherId)
          .maybeSingle();

        if (profile) {
          query = query.eq('teacher_id', profile.id);
        } else {
          query = query.eq('teacher_id', teacherId);
        }
      } else {
        query = query.eq('teacher_id', teacherId);
      }
    } else {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle();

        if (profile) {
          query = query.eq('teacher_id', profile.id);
        }
      }
    }

    if (filters?.textbookId) {
      query = query.eq('textbook_id', filters.textbookId);
    }
    if (filters?.chapterId) {
      query = query.eq('chapter_id', filters.chapterId);
    }
    if (filters?.subchapterId) {
      query = query.eq('subchapter_id', filters.subchapterId);
    }
    if (filters?.folderIds && filters.folderIds.length > 0) {
      query = query.in('folder_id', filters.folderIds);
    } else if (filters?.folderId) {
      query = query.eq('folder_id', filters.folderId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  // 문제 생성
  createProblem: async (problemData) => {
    const { data, error } = await supabase
      .from('problems')
      .insert(problemData)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // 문제 수정
  updateProblem: async (id, updates) => {
    const { data, error } = await supabase
      .from('problems')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // 문제 삭제
  deleteProblem: async (id) => {
    const { error } = await supabase
      .from('problems')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }
};

// ===== 문제 세트 관련 API =====
export const problemSetApi = {
  // 폴더 목록 조회
  getFolders: async () => {
    const { data, error } = await supabase
      .from('folders')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // 문제 세트 목록 조회 (현재 사용자)
  getProblemSets: async (teacherId) => {
    console.log('getProblemSets 호출됨, teacherId:', teacherId);
    
    if (!teacherId) {
      console.log('teacherId가 없어서 빈 배열 반환');
      return [];
    }

    const { data, error } = await supabase
      .from('problem_sets')
      .select(`
        *,
        problems:problem_set_items(
          problem:problems(*)
        )
      `)
      .eq('teacher_id', teacherId)
      .order('created_at', { ascending: false });

    console.log('문제 세트 조회 결과:', { data, error });

    if (error) throw error;
    
    // 문제 개수 추가
    const problemSetsWithCount = (data || []).map(problemSet => ({
      ...problemSet,
      problemCount: problemSet.problems?.length || 0
    }));
    
    console.log('문제 개수 포함된 문제 세트:', problemSetsWithCount);
    return problemSetsWithCount;
  },

  // 문제 세트 목록 조회 (폴더별)
  getProblemSetsByFolder: async (folderId) => {
    let query = supabase
      .from('problem_sets')
      .select(`
        *,
        problems:problem_set_items(
          problem:problems(*)
        )
      `)
      .order('created_at', { ascending: false });

    if (folderId) {
      query = query.eq('folder_id', folderId);
    }

    const { data, error } = await query;
    if (error) throw error;

    // 문제 세트별로 문제 개수 계산
    const problemSetsWithCount = (data || []).map((set) => ({
      ...set,
      problem_count: set.problems?.length || 0,
      problems: set.problems?.map((item) => item.problem).filter(Boolean) || []
    }));

    return problemSetsWithCount;
  },

  // 문제 세트 생성
  createProblemSet: async (data) => {
    console.log('problemSetApi.createProblemSet 호출됨, data:', data);
    
    // 현재 사용자의 프로필 ID 가져오기
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('사용자가 인증되지 않았습니다.');

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle();

    console.log('프로필 조회 결과:', { profile, profileError });

    if (profileError) throw profileError;
    if (!profile) throw new Error('프로필을 찾을 수 없습니다.');

    // created_at, updated_at 필드 제거 (데이터베이스에서 자동 생성)
    const { created_at, updated_at, ...cleanData } = data;
    
    // 빈 문자열인 UUID 필드들을 null로 변환
    const processedData = {
      ...cleanData,
      folder_id: cleanData.folder_id && cleanData.folder_id.trim() !== '' ? cleanData.folder_id : null
    };
    
    const insertData = {
      ...processedData,
      teacher_id: profile.id,
      is_favorite: data.is_favorite || false
    };
    
    console.log('삽입할 데이터:', insertData);

    const { data: result, error } = await supabase
      .from('problem_sets')
      .insert(insertData)
      .select()
      .single();

    console.log('문제 세트 삽입 결과:', { result, error });
    console.log('오류 상세 정보:', error);

    if (error) {
      console.error('문제 세트 생성 실패 - 상세 오류:', error);
      throw error;
    }
    return result;
  },

  // 문제 세트 수정
  updateProblemSet: async (id, updates) => {
    // teacher_id가 업데이트에 포함되지 않도록 필터링
    const { teacher_id, ...updateData } = updates;
    
    const { data, error } = await supabase
      .from('problem_sets')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // 문제 세트 삭제
  deleteProblemSet: async (id) => {
    const { error } = await supabase
      .from('problem_sets')
      .delete()
      .eq('id', id);

    if (error) throw error;
  },

  // 문제 세트에 문제 추가
  addProblemsToSet: async (problemSetId, problemIds) => {
    const items = problemIds.map((problemId, index) => ({
      problem_set_id: problemSetId,
      problem_id: problemId,
      sort_order: index
    }));

    const { error } = await supabase
      .from('problem_set_items')
      .insert(items);

    if (error) throw error;
    await supabase.rpc('recalc_set_difficulty', { p_set_id: problemSetId });
  },

  // 문제 세트의 문제 순서 재정렬
  reorderProblemsInSet: async (problemSetId) => {
    // 문제 세트의 문제들을 번호 순으로 정렬
    const { data: items, error: fetchError } = await supabase
      .from('problem_set_items')
      .select(`
        *,
        problem:problems(*)
      `)
      .eq('problem_set_id', problemSetId)
      .order('sort_order', { ascending: true });

    if (fetchError) throw fetchError;

    // 문제 번호 순으로 정렬
    const sortedItems = items
      .map(item => ({ ...item, problem: item.problem }))
      .sort((a, b) => (a.problem?.problem_number || 0) - (b.problem?.problem_number || 0));

    // 순서 업데이트
    const updates = sortedItems.map((item, index) => ({
      id: item.id,
      sort_order: index
    }));

    const { error: updateError } = await supabase
      .from('problem_set_items')
      .upsert(updates);

    if (updateError) throw updateError;
  },

  // 문제 세트의 문제들을 완전히 교체
  replaceProblemsInSet: async (problemSetId, problemIds) => {
    // 기존 문제들을 모두 제거
    const { error: deleteError } = await supabase
      .from('problem_set_items')
      .delete()
      .eq('problem_set_id', problemSetId);

    if (deleteError) throw deleteError;

    // 새로운 문제들을 추가
    if (problemIds.length > 0) {
      const items = problemIds.map((problemId, index) => ({
        problem_set_id: problemSetId,
        problem_id: problemId,
        sort_order: index
      }));

      const { error: insertError } = await supabase
        .from('problem_set_items')
        .insert(items);

      if (insertError) throw insertError;
    }
    await supabase.rpc('recalc_set_difficulty', { p_set_id: problemSetId });
  }
};

// ===== 배포 관련 API =====
/**
 * "오늘까지" 의 경계 = **내일 로컬 자정**.
 *
 * ⚠️ 학생에게 과제를 가릴 때 `now()` 와 비교하면 **시각까지** 따지게 된다 — 같은 날 배포인데도
 *    그 시각 전에는 안 보인다(실측: KST 8/28 09:00 로 저장된 배포가 08:46 에 "배포된 문제집 0개").
 *    과제는 **날짜 단위**다. 그날이면 0시부터 24시간 내내 보여야 한다.
 *
 * 경계를 내일 자정으로 두면 **오늘 날짜면 시각과 무관하게 전부 보이고**, 미래 '날짜' 예약은
 * 그대로 가려진다(복습 예약이 그날 되어야 뜨는 규칙은 유지).
 *
 * (reviewSchedule.ts 의 toDateStr 를 쓰고 싶지만 그쪽이 이 파일을 import 해 순환이 된다.)
 */
const endOfTodayIso = (): string => {
  const d = new Date();
  d.setHours(24, 0, 0, 0);   // 내일 로컬 자정
  return d.toISOString();
};

export const distributionApi = {
  // 배포 목록 조회
  getDistributions: async () => {
    const { data, error } = await supabase
      .from('distributions')
      .select(`
        *,
        problem_set:problem_sets(
          *,
          problems:problem_set_items(
            problem:problems(
              id,
              title,
              problem_number,
              difficulty,
              unit,
              answer_type,
              correct_answer,
              choices,
              explanation,
              image_url,
              teacher_id,
              created_at,
              updated_at
            )
          )
        ),
        students:distribution_students(
          student:profiles(*)
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
  },

  // 배포 상세 조회
  getDistributionById: async (id, skipAccessCheck = false) => {
    try {
      // 현재 사용자의 프로필 정보 가져오기
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('사용자가 인증되지 않았습니다.');

      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id, role')
        .eq('user_id', user.id)
        .maybeSingle();

      if (profileError) throw profileError;
      if (!profile) throw new Error('프로필을 찾을 수 없습니다.');

      // 학생인 경우 distribution_students 테이블을 통해 접근 권한 확인 (skipAccessCheck가 false일 때만)
      if (profile.role === 'student' && !skipAccessCheck) {
        // 먼저 학생이 이 배포에 접근할 수 있는지 확인.
        // 합성키(distribution_id, student_id) 조회는 0행(미등록)이 정상 케이스 →
        // .single() 은 0행에서 406 을 던지므로 .maybeSingle()(0행=null) 이 맞다.
        // (026 에서 UNIQUE(distribution_id, student_id) 추가 → 2행 불가.)
        const { data: accessCheck, error: accessError } = await supabase
          .from('distribution_students')
          .select('distribution_id')
          .eq('distribution_id', id)
          .eq('student_id', profile.id)
          .maybeSingle();

        if (accessError || !accessCheck) {
          throw new Error('이 배포에 접근할 권한이 없습니다.');
        }
      }

      // 배포 데이터 조회 (더 간단한 쿼리)
      const { data, error } = await supabase
        .from('distributions')
        .select('*')
        .eq('id', id)
        .single();

      if (error) throw error;

      // 예약(미래) 배포 가드 — 학생이 URL 을 직접 쳐서 미리 여는 것을 막는다.
      // 반드시 select 뒤에 둬야 distribution_date 를 볼 수 있다.
      // skipAccessCheck=true(목록 경로/교사 조회)는 통과시킨다.
      if (profile.role === 'student' && !skipAccessCheck && data?.distribution_date) {
        // 목록과 **같은 기준**(날짜 단위)이어야 한다 — 여기만 시각으로 보면
        // 목록엔 떠 있는데 열면 "아직 시작되지 않은 과제입니다" 가 된다.
        if (new Date(data.distribution_date).getTime() >= new Date(endOfTodayIso()).getTime()) {
          throw new Error('아직 시작되지 않은 과제입니다.');
        }
      }

      // 문제 세트 정보 조회
      if (data.problem_set_id) {
        const { data: problemSet, error: psError } = await supabase
          .from('problem_sets')
          .select('id, name, description, total_problems')
          .eq('id', data.problem_set_id)
          .single();

        if (psError) {
          console.error('문제 세트 조회 오류:', psError);
          // 문제 세트 조회 실패 시 기본 정보만 설정
          data.problem_set = {
            id: data.problem_set_id,
            name: '알 수 없는 문제 세트',
            description: '',
            total_problems: 0
          };
        } else {
          data.problem_set = problemSet;
        }

        // 문제 세트의 문제들을 별도로 조회
        const { data: problemItems, error: problemError } = await supabase
          .from('problem_set_items')
          .select(`
            problem:problems(
              id,
              title,
              problem_number,
              difficulty,
              unit,
              answer_type,
              correct_answer,
              choices,
              explanation,
              image_url,
              teacher_id,
              created_at,
              updated_at
            )
          `)
          .eq('problem_set_id', data.problem_set_id)
          .order('sort_order');

        if (problemError) {
          console.error('문제 조회 오류:', problemError);
          data.problem_set.problems = [];
        } else {
          // 문제 데이터를 올바른 구조로 변환
          data.problem_set.problems = problemItems.map(item => item.problem);
        }
      }

      return data;
    } catch (error) {
      console.error('getDistributionById 오류:', error);
      throw error;
    }
  },

  // 학생에게 배포된 문제 세트 조회
  // options.hideScheduled=true 면 아직 시작 안 된(미래) 예약 배포를 제외한다.
  // 기본 false 인 이유: 선생님 화면(StudentAnalysis)·CMS 는 예약 배포까지 보고 싶어 한다.
  // 여기서 기본값을 바꾸면 그쪽이 조용히 회귀한다 → 학생 앱만 명시적으로 켠다.
  getStudentDistributions: async (studentId, options: { hideScheduled?: boolean } = {}) => {
    try {
      const { data: distributionStudents, error: dsError } = await supabase
        .from('distribution_students')
        .select('distribution_id')
        .eq('student_id', studentId);

      if (dsError) throw dsError;

      if (!distributionStudents || distributionStudents.length === 0) {
        return [];
      }

      const distributionIds = distributionStudents.map(ds => ds.distribution_id);

      let distQuery = supabase
        .from('distributions')
        .select('*')
        .in('id', distributionIds);

      if (options.hideScheduled) {
        // 시각이 아니라 **날짜** 기준 — 오늘 배포는 0시부터 하루 종일 보인다(endOfTodayIso 주석).
        distQuery = distQuery.lt('distribution_date', endOfTodayIso());
      }

      const { data: distributions, error: distError } = await distQuery
        .order('created_at', { ascending: false });

      if (distError) throw distError;

      const detailedDistributions = await Promise.all(
        distributions.map(async (dist) => {
          const detailedDist = await distributionApi.getDistributionById(dist.id, true);
          return detailedDist;
        })
      );

      return detailedDistributions.filter(Boolean);

    } catch (error) {
      console.error('학생 배포 조회 오류:', error);
      throw error;
    }
  },

  // 특정 학생이 특정 달(year, month: 1~12)에 받은 배포 목록 (달력 셀 메모용 경량 조회)
  getDistributionsByStudentAndMonth: async (studentId, year, month) => {
    // 1) 이 학생에게 연결된 distribution_id 수집
    const { data: distributionStudents, error: dsError } = await supabase
      .from('distribution_students')
      .select('distribution_id')
      .eq('student_id', studentId);
    if (dsError) throw dsError;
    if (!distributionStudents || distributionStudents.length === 0) return [];

    const distributionIds = distributionStudents.map(ds => ds.distribution_id);

    // 2) 그 중 distribution_date 가 해당 달 범위인 것만 select (경량 컬럼)
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 1); // 다음 달 1일 (미포함)
    // review_kind 는 달력 칩 색(원본 파랑 / 다음수업 빨 / 2주 주 / 4주 노)에 쓴다
    const { data, error } = await supabase
      .from('distributions')
      .select('id, title, distribution_date, review_kind')
      .in('id', distributionIds)
      .gte('distribution_date', start.toISOString())
      .lt('distribution_date', end.toISOString())
      .order('distribution_date', { ascending: true });
    if (error) throw error;

    return (data || []).map(d => ({
      distribution_id: d.id,
      title: d.title,
      distribution_date: d.distribution_date,
      review_kind: (d as any).review_kind ?? null,
    }));
  },

  // 배포 생성
  createDistribution: async (data) => {
    const { data: result, error } = await supabase
      .from('distributions')
      .insert(data)
      .select()
      .single();

    if (error) throw error;
    return result;
  },

  // 학생들을 배포에 추가
  addStudentsToDistribution: async (distributionId, studentIds) => {
    const items = studentIds.map(studentId => ({
      distribution_id: distributionId,
      student_id: studentId
    }));

    const { error } = await supabase
      .from('distribution_students')
      .insert(items);

    if (error) throw error;
  },

  // 배포 수정
  updateDistribution: async (id, data) => {
    const { error } = await supabase
      .from('distributions')
      .update(data)
      .eq('id', id);

    if (error) throw error;
  },

  // 배포 삭제
  deleteDistribution: async (id) => {
    try {
      console.log(`배포 ${id} 삭제 시작...`);
      
      // 1. 먼저 해당 배포의 오답들을 삭제 (student_id와 problem_id로 매칭)
      const { data: studentAnswers, error: fetchError } = await supabase
        .from('student_answers')
        .select('student_id, problem_id')
        .eq('distribution_id', id);

      if (fetchError) {
        console.error('학생 답안 조회 오류:', fetchError);
        throw fetchError;
      }

      console.log(`조회된 학생 답안 수: ${studentAnswers?.length || 0}`);

      // 2. 해당 배포의 오답들을 삭제
      if (studentAnswers && studentAnswers.length > 0) {
        for (const answer of studentAnswers) {
          const { error: wrongAnswerError } = await supabase
            .from('wrong_answers')
            .delete()
            .eq('student_id', answer.student_id)
            .eq('problem_id', answer.problem_id);

          if (wrongAnswerError) {
            console.error('오답 삭제 오류:', wrongAnswerError);
          }
        }
        console.log('오답 삭제 완료');
      }

      // 3. 학생 배포 관계 삭제
      const { error: studentsError } = await supabase
        .from('distribution_students')
        .delete()
        .eq('distribution_id', id);

      if (studentsError) {
        console.error('학생 배포 관계 삭제 오류:', studentsError);
        throw studentsError;
      }
      console.log('학생 배포 관계 삭제 완료');

      // 4. 배포 삭제 (CASCADE DELETE로 인해 student_answers도 자동 삭제됨)
      const { error: distributionError } = await supabase
        .from('distributions')
        .delete()
        .eq('id', id);

      if (distributionError) {
        console.error('배포 삭제 오류:', distributionError);
        throw distributionError;
      }

      console.log(`배포 ${id} 삭제 완료`);
    } catch (error) {
      console.error('배포 삭제 중 오류 발생:', error);
      throw error;
    }
  }
};

// ===== 학생 관련 API =====
export const studentApi = {
  // 학생 목록 조회
  getStudents: async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'student')
      .order('name', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // 특정 선생님에게 등록된 학생들 조회
  getStudentsByTeacher: async (teacherEmail) => {
    try {
      console.log('getStudentsByTeacher 호출됨, teacherEmail:', teacherEmail);
      
      // 1. 선생님의 프로필 ID 찾기.
      // email 로 조회 → 0행(그 이메일 teacher 없음)이 정상 케이스라 .maybeSingle()(0행=null).
      // .single() 은 0행에서 406. (026 에서 profiles.email UNIQUE 추가 → 2행 불가.)
      const { data: teacherProfile, error: teacherError } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', teacherEmail)
        .eq('role', 'teacher')
        .maybeSingle();

      console.log('선생님 프로필 조회 결과:', { teacherProfile, teacherError });

      if (teacherError || !teacherProfile) {
        console.log('선생님 프로필을 찾을 수 없습니다:', teacherEmail);
        return [];
      }

      // 2. profiles 테이블에서 teacher_id로 직접 학생 조회 (올바른 방법)
      console.log('teacherProfile.id:', teacherProfile.id);
      
      const { data: students, error: studentsError } = await supabase
        .from('profiles')
        .select('*')
        .eq('role', 'student')
        .eq('teacher_id', teacherProfile.id);

      console.log('profiles에서 teacher_id로 학생 조회 결과:', { students, studentsError });
      console.log('조회된 학생 상세 정보:', students?.map(s => ({ id: s.id, name: s.name, email: s.email, teacher_id: s.teacher_id })));

      if (studentsError) {
        console.error('학생 조회 오류:', studentsError);
        return [];
      }

      const result = students || [];
      console.log('최종 학생 목록:', result);
      
      // 만약 결과가 비어있다면, 디버깅 정보 제공
      if (result.length === 0) {
        console.warn('등록된 학생이 없습니다. 디버깅 정보:');
        console.warn('선생님 ID:', teacherProfile.id);
        console.warn('선생님 이메일:', teacherEmail);
        
        // 모든 학생 조회해서 teacher_id 상태 확인
        const { data: allStudents, error: allStudentsError } = await supabase
          .from('profiles')
          .select('*')
          .eq('role', 'student');
        
        if (allStudents && allStudents.length > 0) {
          console.warn('데이터베이스에 학생이 있지만 teacher_id가 다릅니다:');
          allStudents.forEach(student => {
            console.warn(`- ${student.name} (${student.email}): teacher_id = ${student.teacher_id}`);
          });
          console.warn('해결 방법: 학생 등록 페이지에서 해당 학생을 다시 등록하세요.');
        } else {
          console.warn('데이터베이스에 학생이 없습니다.');
        }
      }
      
      return result;
    } catch (error) {
      console.error('선생님의 학생 조회 오류:', error);
      return [];
    }
  }
};

// ===== 폴더 관련 API (임시 복구) =====
export const folderApi = {
  // 폴더 목록 조회
  getFolders: async () => {
    const { data, error } = await supabase
      .from('folders')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) throw error;
    return data || [];
  },

  // 폴더 생성
  createFolder: async (data) => {
    const { data: result, error } = await supabase
      .from('folders')
      .insert(data)
      .select()
      .single();

    if (error) throw error;
    return result;
  },

  // 폴더 수정
  updateFolder: async (id, data) => {
    const { data: result, error } = await supabase
      .from('folders')
      .update(data)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return result;
  },

  // 폴더 삭제
  deleteFolder: async (id) => {
    const { error } = await supabase
      .from('folders')
      .delete()
      .eq('id', id);

    if (error) throw error;
  }
};

// ===== 학생 답안 관련 API =====
export const studentAnswerApi = {
  // 학생 답안 제출 (항상 새로운 레코드 추가)
  submitAnswer: async (data) => {
    try {
      // 항상 새로운 답안 추가
      const { data: result, error } = await supabase
        .from('student_answers')
        .insert(data)
        .select()
        .single();

      if (error) throw error;
      return result;
    } catch (error) {
      console.error('학생 답안 제출 오류:', error);
      throw error;
    }
  },

  // 학생 답안 조회
  getStudentAnswers: async (studentId, distributionId = null) => {
    let query = supabase
      .from('student_answers')
      .select('*')
      .eq('student_id', studentId);

    if (distributionId) {
      query = query.eq('distribution_id', distributionId);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  },

  /**
   * 문제별 **전체** 시도 요약 (배포와 무관): 횟수 + 마지막 제출 시각.
   *
   * 학생 화면의 "오답 숙제하기 (N회차)" 가 선생님 오답 표의 회차 칸과 어긋나지 않으려면
   * **같은 기준으로 세야** 한다. 선생님 쪽(`get_student_wrong_answers.total_attempts`,
   * 034_review_timeline.sql)은 배포로도 기간으로도 안 거르고 그 학생의 student_answers 를
   * 통째로 센다 — 여기도 똑같이 센다. 배포별로 세면 복습 예약 배포에서 푼 회차가 빠져
   * 학생 화면만 "2회차" 에 머무른다.
   *
   * `lastAt` 은 "오늘 몫을 이미 했는가" 판정용이다(하루 한 회차 — planWrongHomework 참조).
   *
   * ⚠️ `.range()` 페이징은 `.order()` 와 짝으로 건다 — 정렬이 없으면 페이지 경계에서 행이
   *    조용히 빠지거나 겹친다(db-conventions). 회차가 하나 덜 세지면 학생이 같은 회차를
   *    두 번 풀게 되므로 여기서 특히 위험하다.
   */
  getProblemAttemptStats: async (
    studentId: string
  ): Promise<Record<string, { count: number; lastAt: string | null }>> => {
    const stats: Record<string, { count: number; lastAt: string | null }> = {};
    const PAGE = 1000;

    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('student_answers')
        .select('id, problem_id, submitted_at')
        .eq('student_id', studentId)
        .order('id')
        .range(from, from + PAGE - 1);

      if (error) throw error;
      (data || []).forEach((row: any) => {
        const cur = stats[row.problem_id] || { count: 0, lastAt: null };
        cur.count += 1;
        // 페이지 순서는 id 순이라 시간순이 아니다 — 최댓값을 직접 고른다.
        if (row.submitted_at && (!cur.lastAt || row.submitted_at > cur.lastAt)) {
          cur.lastAt = row.submitted_at;
        }
        stats[row.problem_id] = cur;
      });
      if (!data || data.length < PAGE) break;
    }

    return stats;
  }
};

// ===== 오답 노트 관련 API =====
export const wrongAnswerApi = {
  // 오답 추가 (중복 처리)
  addWrongAnswer: async (data) => {
    try {
      // 먼저 기존 오답이 있는지 확인.
      // 합성키(student_id, problem_id) 조회 — 0행(첫 오답)이 정상 케이스라 .maybeSingle()(0행=null).
      // .single() 은 0행에서 406(PGRST116) 을 던져 우회 코드가 필요했으나 maybeSingle 로 불필요.
      // (026 에서 UNIQUE(student_id, problem_id) 추가 → 2행 불가.)
      const { data: existingWrongAnswer, error: checkError } = await supabase
        .from('wrong_answers')
        .select('id')
        .eq('student_id', data.student_id)
        .eq('problem_id', data.problem_id)
        .maybeSingle();

      if (checkError) {
        throw checkError;
      }

      if (existingWrongAnswer) {
        // 기존 오답이 있으면 업데이트 (최신 오답으로 교체)
        const { data: result, error } = await supabase
          .from('wrong_answers')
          .update({ 
            wrong_answer: data.wrong_answer,
            attempt_number: data.attempt_number || 1,
            updated_at: new Date().toISOString()
          })
          .eq('id', existingWrongAnswer.id)
          .select()
          .single();

        if (error) throw error;
        return result;
      } else {
        // 새로운 오답 추가
        const { data: result, error } = await supabase
          .from('wrong_answers')
          .insert({
            ...data,
            attempt_number: data.attempt_number || 1
          })
          .select()
          .single();

        if (error) throw error;
        return result;
      }
    } catch (error) {
      console.error('오답 추가 오류:', error);
      // 오답 추가 실패해도 전체 제출 프로세스는 계속 진행
      return null;
    }
  },

  // 오답 제거 (정답을 맞췄을 때)
  removeWrongAnswer: async (studentId, problemId) => {
    try {
      const { error } = await supabase
        .from('wrong_answers')
        .delete()
        .eq('student_id', studentId)
        .eq('problem_id', problemId);

      if (error) throw error;
      return true;
    } catch (error) {
      console.error('오답 제거 오류:', error);
      return false;
    }
  },

  // 오답 목록 조회
  getWrongAnswers: async (studentId) => {
    const { data, error } = await supabase
      .from('wrong_answers')
      .select('*')
      .eq('student_id', studentId);

    if (error) throw error;
    return data || [];
  }
};

// ===== 배포 도전 횟수 관련 API =====
export const distributionAttemptApi = {
  // 도전 기록 추가
  addAttempt: async (studentId, distributionId, attemptType) => {
    const { data, error } = await supabase
      .from('distribution_attempts')
      .insert({
        student_id: studentId,
        distribution_id: distributionId,
        attempt_type: attemptType
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  // 학생의 특정 배포에 대한 도전 횟수 조회
  getAttemptCount: async (studentId, distributionId) => {
    const { data, error } = await supabase
      .from('distribution_attempts')
      .select('*')
      .eq('student_id', studentId)
      .eq('distribution_id', distributionId);

    if (error) throw error;
    return data || [];
  },

  // 학생의 모든 배포에 대한 총 도전 횟수 조회
  getTotalAttemptCount: async (studentId) => {
    const { data, error } = await supabase
      .from('distribution_attempts')
      .select('*')
      .eq('student_id', studentId);

    if (error) throw error;
    return data || [];
  }
};

// ===== 막힌 지점 도우미 (풀이 그래프 위치추적 RAG) API =====
// 백엔드: backend/pdf_pipeline (포트 8001). POST /api/tutor/hint
// (구 deeptutor 폐기 — 2026-06-18. VITE_DEEPTUTOR_URL 은 하위호환 fallback)
const TUTOR_API_BASE_URL =
  (import.meta as any).env?.VITE_TUTOR_API_URL ||
  (import.meta as any).env?.VITE_DEEPTUTOR_URL ||
  'http://localhost:8001';

export const ragHintApi = {
  // 막힌 지점 힌트 1발. revealedNodeIndex 로 멀티턴("다음 힌트") 이어가기.
  getHint: async (params: {
    problemId: string;
    blockedDescription: string;
    revealedNodeIndex?: number;
    // 직전까지의 대화 이력(최근 N턴) — 백엔드가 _localize/_generate 맥락으로 사용(15차).
    conversationHistory?: { role: string; text: string }[];
  }) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('로그인이 필요합니다');

    // 힌트 생성은 실측상 3~16초(백엔드 결백, 16회 측정). 어쩌다 느려도 50초면 충분 —
    // 95초는 과해 사용자가 오래 기다림(16차). 50초 timeout 후 친화 에러 + 재시도 유도.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 50000);

    let resp: Response;
    try {
      resp = await fetch(`${TUTOR_API_BASE_URL}/api/tutor/hint`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          problem_id: params.problemId,
          student_blocked_description: params.blockedDescription,
          revealed_node_index: params.revealedNodeIndex ?? -1,
          conversation_history: params.conversationHistory ?? [],
        }),
        signal: controller.signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        throw new Error('힌트가 오래 걸려요. 잠시 후 다시 시도해주세요.');
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!resp.ok) {
      let detail = '힌트 생성에 실패했습니다';
      try {
        const body = await resp.json();
        detail = body?.detail || detail;
      } catch { /* ignore */ }
      throw new Error(detail);
    }
    return resp.json();
  },
};

// ===== CMS 풀이 노드 편집 API (교사 전용) =====
// 백엔드: backend/pdf_pipeline (포트 8001). /api/cms/problems/{problemId}/nodes...
// 노드 수정/추가 시 서버가 embedding_text 재합성 + bge-m3 재임베딩, uses(DAG)·순번 자동 정리.
export interface SolutionNodeWhy {
  question: string;
  reason: string;
}
export interface SolutionNode {
  node_index: number;
  role: string;
  entry_conditions: string | null;
  key_concept: string;
  output_formula: string;
  uses: number[];
  whys: SolutionNodeWhy[];
  figure_description: string | null;
  figure_image_crop_url: string | null;
}

async function _nodeAuthHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('로그인이 필요합니다');
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.access_token}`,
  };
}

async function _nodeFetch(path: string, init?: RequestInit): Promise<{ problem_id: string; nodes: SolutionNode[] }> {
  const headers = await _nodeAuthHeaders();
  const resp = await fetch(`${TUTOR_API_BASE_URL}/api/cms/problems${path}`, { ...init, headers });
  if (!resp.ok) {
    let detail = '노드 작업에 실패했습니다';
    try { detail = (await resp.json())?.detail || detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return resp.json();
}

// 노드 본문 입력(서버 NodeIn 과 일치 — node_index 는 서버가 순번 부여).
export type SolutionNodeInput = Omit<SolutionNode, 'node_index'>;

export const nodeApi = {
  list: (problemId: string) =>
    _nodeFetch(`/${problemId}/nodes`),

  update: (problemId: string, nodeIndex: number, body: SolutionNodeInput) =>
    _nodeFetch(`/${problemId}/nodes/${nodeIndex}`, { method: 'PUT', body: JSON.stringify(body) }),

  add: (problemId: string, body: SolutionNodeInput, atIndex?: number) =>
    _nodeFetch(`/${problemId}/nodes${atIndex != null ? `?at_index=${atIndex}` : ''}`, {
      method: 'POST', body: JSON.stringify(body),
    }),

  remove: (problemId: string, nodeIndex: number) =>
    _nodeFetch(`/${problemId}/nodes/${nodeIndex}`, { method: 'DELETE' }),

  reExtract: (problemId: string) =>
    _nodeFetch(`/${problemId}/nodes/re-extract`, { method: 'POST' }),
};

// ===== 학생 성취도/취약점 분석 API (Postgres RPC 래퍼) =====
// 집계는 DB RPC(022_student_analytics_rpcs)에서 "최신 시도 기준"으로 처리한다.
export interface AchievementRow {
  distribution_id: string;
  distribution_title: string;
  total_problems: number;
  attempted: number;
  correct: number;
  accuracy: number;
}

export interface WeaknessRow {
  dimension: 'unit' | 'difficulty' | 'concept' | 'skill';
  label: string;
  total: number;
  correct: number;
  accuracy: number;
}

export interface ClassSummaryRow {
  student_id: string;
  student_name: string;
  attempted: number;
  correct: number;
  accuracy: number;
  distributions_count: number;
}

// 반 전체 진행률(배포 합산) + 정답률. RPC get_teacher_class_progress 반환.
export interface ProgressRow {
  student_id: string;
  student_name: string;
  total_assigned: number;   // 받은 총 문항
  total_attempted: number;  // 푼 총 문항
  progress_pct: number;     // 0~100
  correct: number;
  accuracy: number;
}

export const analyticsApi = {
  // 학생의 배포별 성취도 (전체 합산은 프론트에서 계산)
  getStudentAchievement: async (studentId: string): Promise<AchievementRow[]> => {
    const { data, error } = await supabase.rpc('get_student_achievement', {
      p_student_id: studentId,
    });
    if (error) throw error;
    return data || [];
  },

  // 학생의 취약 영역 (정답률 threshold 이하). dimension: unit/difficulty/concept/skill
  getStudentWeaknesses: async (studentId: string, threshold = 50): Promise<WeaknessRow[]> => {
    const { data, error } = await supabase.rpc('get_student_weaknesses', {
      p_student_id: studentId,
      p_threshold: threshold,
    });
    if (error) throw error;
    return data || [];
  },

  // 선생님 반 전체 학생 요약 (정답률 낮은 순, 미풀이 학생은 뒤로)
  getClassSummary: async (teacherId: string): Promise<ClassSummaryRow[]> => {
    const { data, error } = await supabase.rpc('get_teacher_class_summary', {
      p_teacher_id: teacherId,
    });
    if (error) throw error;
    return data || [];
  },

  // 선생님 반 전체 학생 진행률(전체 배포 합산) + 정답률.
  // Postgres numeric 은 문자열로 직렬화될 수 있어 숫자 필드를 명시적으로 Number 변환.
  getClassProgress: async (teacherId: string): Promise<ProgressRow[]> => {
    const { data, error } = await supabase.rpc('get_teacher_class_progress', {
      p_teacher_id: teacherId,
    });
    if (error) throw error;
    return (data || []).map((r) => ({
      student_id: r.student_id,
      student_name: r.student_name,
      total_assigned: Number(r.total_assigned) || 0,
      total_attempted: Number(r.total_attempted) || 0,
      progress_pct: Number(r.progress_pct) || 0,
      correct: Number(r.correct) || 0,
      accuracy: Number(r.accuracy) || 0,
    }));
  },
};

// ===== 오답 관리 / 복습 예약 =====
// 오답의 유일한 진실 원천은 student_answers(append-only) 다.
// wrong_answers 는 정답 시 DELETE 로 이력이 소실되고 updated_at 컬럼이 없어 UPDATE 가
// 무음 실패하므로 여기서는 쓰지 않는다(031 RPC 도 마찬가지).

export interface WrongAnswerRow {
  problem_id: string;
  problem_title: string;
  problem_number: number;
  source_label: string | null;
  unit: string | null;
  difficulty: string | null;
  image_url: string | null;
  correct_answer: string | null;
  answer_type: string | null;
  choices: any | null;
  first_wrong_at: string;
  last_wrong_at: string;
  wrong_count: number;
  attempt_count: number;   // 기간 필터 안의 시도 수
  total_attempts: number;  // 기간 무관 전체 시도 수 — 진행도(n/5)는 이걸 쓴다
  attempt_dates: string[];      // 실제 시도 날짜(시간순) — 회차 타임라인의 근거
  attempt_results: boolean[];   // 각 시도의 정답 여부(같은 순서)
  scheduled: { distribution_id: string; stage: number | null; kind: ReviewKind | null; date: string }[];
  is_still_wrong: boolean;
  last_answer: string | null;
  origin_distribution_id: string | null;
  origin_distribution_title: string | null;
  origin_distribution_date: string | null;
}

export interface TeacherWrongCountRow {
  student_id: string;
  student_name: string;
  wrong_problems: number;
  still_wrong: number;
  under_target: number;    // 아직 목표 회차(5회)를 못 채운 문제 수
  last_wrong_at: string | null;
}

export interface ScheduledReviewRow {
  distribution_id: string;
  title: string;
  distribution_date: string;
  due_at: string | null;
  review_stage: number;
  review_kind: ReviewKind | null;
  problem_count: number;
}

/** 복습 배포 3개가 안 만들어진 원본 배포 (안전망 배너용) */
export interface MissingReviewBatch {
  distribution_id: string;
  distribution_title: string;
  student_id: string;
  student_name: string;
  /** 그 학생이 이 과제를 처음 푼 시각 — 복습 날짜 계산의 기준일 */
  first_attempt_at: string;
  wrong_count: number;
}

/**
 * 한 번 틀린 문제를 총 몇 회 풀릴 것인가 (최초 1회 + 복습 4회).
 * **정답 여부와 무관하게** 채운다 — 3회차에 맞아도 4회차를 푼다.
 * (reviewSchedule.ts 가 이걸 re-export 한다. 순환 import 를 피해 원본은 여기에 둔다.)
 */
export const REVIEW_TARGET_ROUNDS = 5;

/**
 * 학생 등록경로 (036). **코드로 저장하고 화면에서만 한글로 보여준다** —
 * 자유 입력이면 '인스타'·'인스타그램'·'insta' 가 섞여 나중에 경로별로 못 센다.
 * DB 쪽은 `ck_profiles_enroll_source` CHECK 이 같은 목록을 강제한다(둘을 같이 고칠 것).
 */
export type EnrollSource = 'instagram' | 'youtube' | 'referral' | 'blog' | 'karrot' | 'etc';

export const ENROLL_SOURCE_LABEL: Record<EnrollSource, string> = {
  instagram: '인스타',
  youtube: '유튜브',
  referral: '지인소개',
  blog: '블로그',
  karrot: '당근마켓',
  etc: '기타',
};

/** 화면에 보여줄 순서 */
export const ENROLL_SOURCES: EnrollSource[] = ['instagram', 'youtube', 'referral', 'blog', 'karrot', 'etc'];

// 오답 복습 4단계 + 보충. 당일(처음 푸는 날)은 선생님이 직접 배포하므로 자동 예약 대상이 아니다.
export type ReviewKind = 'homework' | 'next_class' | 'week2' | 'week4' | 'makeup';

export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  homework: '숙제',
  next_class: '다음 수업',
  week2: '2주',
  week4: '4주',
  makeup: '보충',      // 결석·보강으로 빈 회차를 메우는 임시 배포
};

export interface ReviewStageInput {
  stage: number;      // 회차 1~4
  kind: ReviewKind;
  label: string;
  date: string;       // 'YYYY-MM-DD'
}

export const wrongAnswerReviewApi = {
  // 학생 오답 목록. bigint/numeric 은 문자열로 올 수 있어 명시적으로 Number 변환.
  getStudentWrongAnswers: async (
    studentId: string,
    opts: { from?: string | null; to?: string | null } = {}
  ): Promise<WrongAnswerRow[]> => {
    const { data, error } = await supabase.rpc('get_student_wrong_answers', {
      p_student_id: studentId,
      p_from: opts.from ?? null,
      p_to: opts.to ?? null,
    });
    if (error) throw error;
    return (data || []).map((r: any) => ({
      ...r,
      problem_number: Number(r.problem_number) || 0,
      wrong_count: Number(r.wrong_count) || 0,
      attempt_count: Number(r.attempt_count) || 0,
      total_attempts: Number(r.total_attempts) || 0,
      attempt_dates: r.attempt_dates || [],
      attempt_results: r.attempt_results || [],
      scheduled: r.scheduled || [],
      is_still_wrong: !!r.is_still_wrong,
    }));
  },

  // 선생님 반 학생별 오답 현황 (좌측 목록)
  getTeacherWrongCounts: async (teacherId: string): Promise<TeacherWrongCountRow[]> => {
    const { data, error } = await supabase.rpc('get_teacher_wrong_answer_counts', {
      p_teacher_id: teacherId,
      p_target: REVIEW_TARGET_ROUNDS,
    });
    if (error) throw error;
    return (data || []).map((r: any) => ({
      student_id: r.student_id,
      student_name: r.student_name,
      wrong_problems: Number(r.wrong_problems) || 0,
      still_wrong: Number(r.still_wrong) || 0,
      under_target: Number(r.under_target) || 0,
      last_wrong_at: r.last_wrong_at,
    }));
  },

  // 아직 시작 안 된(예약 상태) 복습 배포 목록
  getScheduledReviews: async (studentId: string): Promise<ScheduledReviewRow[]> => {
    const { data: ds, error: dsError } = await supabase
      .from('distribution_students')
      .select('distribution_id')
      .eq('student_id', studentId);
    if (dsError) throw dsError;
    if (!ds || ds.length === 0) return [];

    const { data: dists, error } = await supabase
      .from('distributions')
      .select('id, title, distribution_date, due_at, review_stage, review_kind, problem_set_id')
      .in('id', ds.map((x: any) => x.distribution_id))
      .not('review_stage', 'is', null)
      // 학생 노출과 **같은 날짜 기준**. 오늘 자 복습은 이미 학생에게 떠 있으므로 '예약'이 아니다.
      .gte('distribution_date', endOfTodayIso())
      .order('distribution_date', { ascending: true });
    if (error) throw error;
    if (!dists || dists.length === 0) return [];

    // 문항 수는 한 번에 세서 매핑 (배포마다 조회하면 N+1)
    const setIds = dists.map((d: any) => d.problem_set_id).filter(Boolean);
    const countBySet: Record<string, number> = {};
    if (setIds.length > 0) {
      const { data: items } = await supabase
        .from('problem_set_items')
        .select('problem_set_id')
        .in('problem_set_id', setIds);
      (items || []).forEach((it: any) => {
        countBySet[it.problem_set_id] = (countBySet[it.problem_set_id] || 0) + 1;
      });
    }

    return dists.map((d: any) => ({
      distribution_id: d.id,
      title: d.title,
      distribution_date: d.distribution_date,
      due_at: d.due_at,
      review_stage: Number(d.review_stage) || 0,
      review_kind: (d.review_kind as ReviewKind) ?? null,
      problem_count: countBySet[d.problem_set_id] || 0,
    }));
  },

  // 복습 예약 생성(숙제/다음수업/2주/4주). RPC 한 방 = 부분 실패로 유령 예약이 남지 않는다.
  // 날짜는 프론트가 계산해 넘긴다 — "다음 수업날"은 학원 운영 규칙(월수금·화목토 격일)이라
  // 바뀔 수 있고, 예약 모달이 날짜를 미리 보여줘야 하기 때문(regenerateReviewStages 참조).
  createReviewReservations: async (params: {
    teacherId: string;
    studentId: string;
    studentName: string;
    problemIds: string[];
    stages: ReviewStageInput[];
    // 시작일·마감일 개념은 쓰지 않는다(사용자 결정) — 날짜 하나로 두고 자유롭게 옮긴다.
    // RPC 기본값이 있어 평소엔 안 넘긴다.
    startTime?: string;
    dueTime?: string;
    parentDistributionId?: string | null;
  }): Promise<{ distribution_id: string; review_stage: number; review_kind: ReviewKind; distribution_date: string }[]> => {
    const { data, error } = await supabase.rpc('create_review_distributions', {
      p_teacher_id: params.teacherId,
      p_student_id: params.studentId,
      p_student_name: params.studentName,
      p_problem_ids: params.problemIds,
      p_stages: params.stages,
      p_start_time: params.startTime || '00:00',
      p_due_time: params.dueTime || '23:59',
      p_parent_distribution_id: params.parentDistributionId ?? null,
    });
    if (error) throw error;
    return (data || []).map((r: any) => ({
      distribution_id: r.distribution_id,
      review_stage: Number(r.review_stage) || 0,
      review_kind: r.review_kind as ReviewKind,
      distribution_date: r.distribution_date,
    }));
  },

  /**
   * 학생이 원본 과제를 다 풀면 복습 배포 3개(다음수업/2주/4주)를 자동 생성한다.
   *
   * **학생 화면에서 부른다.** teacher_id·학생 이름·오답 목록은 전부 RPC 가 DB 에서 파생하므로
   * 클라이언트가 남의 학생에게 만들거나 문제를 끼워 넣을 수 없다. 넘기는 건 날짜뿐이다
   * (월수금·화목토 규칙이 프론트에 있어서 — reviewSchedule.ts).
   *
   * 멱등이다: 이미 만들어져 있으면 아무것도 안 만들고 기존 것을 돌려준다.
   */
  autoCreateReviews: async (params: {
    distributionId: string;
    studentId: string;
    stages: ReviewStageInput[];
  }): Promise<{ distribution_id: string; review_stage: number; review_kind: ReviewKind; distribution_date: string }[]> => {
    const { data, error } = await supabase.rpc('auto_create_reviews_for_distribution', {
      p_distribution_id: params.distributionId,
      p_student_id: params.studentId,
      p_stages: params.stages,
    });
    if (error) throw error;
    return (data || []).map((r: any) => ({
      distribution_id: r.distribution_id,
      review_stage: Number(r.review_stage) || 0,
      review_kind: r.review_kind as ReviewKind,
      distribution_date: r.distribution_date,
    }));
  },

  /**
   * 안전망 — 학생이 풀어서 오답이 났는데 복습 배포 3개가 안 만들어진 원본 배포.
   * (학생 브라우저가 죽거나 오프라인이면 autoCreateReviews 가 못 돈다.)
   */
  findMissingReviewBatches: async (
    teacherId: string,
    days = 14,
  ): Promise<MissingReviewBatch[]> => {
    const { data, error } = await supabase.rpc('find_missing_review_batches', {
      p_teacher_id: teacherId,
      p_days: days,
    });
    if (error) throw error;
    return (data || []).map((r: any) => ({
      distribution_id: r.distribution_id,
      distribution_title: r.distribution_title,
      student_id: r.student_id,
      student_name: r.student_name,
      first_attempt_at: r.first_attempt_at,
      wrong_count: Number(r.wrong_count) || 0,
    }));
  },

  // 예약 날짜 이동 — 결석·보강으로 회차가 밀렸을 때 다른 날로 옮긴다.
  // 시각은 보존하고 날짜만 바꾼다(일반 배포는 시각 입력이 남아 있어 그대로 지켜야 한다).
  rescheduleReview: async (distributionId: string, newDate: string): Promise<string> => {
    const { data: d, error } = await supabase
      .from('distributions')
      .select('id, distribution_date, due_at')
      .eq('id', distributionId)
      .single();
    if (error) throw error;

    const shiftToDate = (iso: string | null, date: string) => {
      if (!iso) return null;
      const t = new Date(iso);
      const [y, m, dd] = date.split('-').map(Number);
      const next = new Date(y, m - 1, dd, t.getHours(), t.getMinutes(), t.getSeconds());
      return next.toISOString();
    };

    const nextStart = shiftToDate(d.distribution_date, newDate) as string;
    // due_at 은 시작일과의 일수 간격을 유지한다(당일 마감이면 그대로 당일 마감).
    let nextDue: string | null = null;
    if (d.due_at) {
      const gapDays = Math.round(
        (new Date(d.due_at).setHours(0, 0, 0, 0) - new Date(d.distribution_date).setHours(0, 0, 0, 0))
        / 86400000
      );
      const [y, m, dd] = newDate.split('-').map(Number);
      const dueDay = new Date(y, m - 1, dd + gapDays);
      nextDue = shiftToDate(
        d.due_at,
        `${dueDay.getFullYear()}-${String(dueDay.getMonth() + 1).padStart(2, '0')}-${String(dueDay.getDate()).padStart(2, '0')}`
      );
    }

    const { error: upError } = await supabase
      .from('distributions')
      .update({ distribution_date: nextStart, ...(nextDue ? { due_at: nextDue } : {}) })
      .eq('id', distributionId);
    if (upError) throw upError;
    return nextStart;
  },

  // 예약 취소 — 이미 시작된 복습은 학생이 풀었을 수 있어(답안 CASCADE) 거부한다.
  cancelReview: async (distributionId: string): Promise<void> => {
    const { data: d, error } = await supabase
      .from('distributions')
      .select('id, distribution_date, review_stage')
      .eq('id', distributionId)
      .single();
    if (error) throw error;
    if (d?.review_stage == null) throw new Error('복습 예약이 아닙니다.');
    // 학생 노출과 같은 날짜 기준 — 오늘 자 복습은 이미 학생 화면에 떠 있으니 취소 불가.
    if (new Date(d.distribution_date).getTime() < new Date(endOfTodayIso()).getTime()) {
      throw new Error('이미 시작된 복습은 취소할 수 없습니다.');
    }
    const { error: delError } = await supabase.from('distributions').delete().eq('id', distributionId);
    if (delError) throw delError;
    // distribution_students 는 FK CASCADE 로 함께 정리된다.
  },
};

// ===== 출석 =====
// 한 학생 하루 1행. 030 의 UNIQUE(student_id, attendance_date) 가 upsert 를 받쳐준다.
// 합성키 단건 조회는 .maybeSingle()(0행=null 정상) — .single() 은 0행에서 406.

export type AttendanceStatus = 'present' | 'late' | 'absent';

export interface AttendanceRow {
  id: string;
  student_id: string;
  teacher_id: string;
  attendance_date: string;   // 'YYYY-MM-DD'
  status: AttendanceStatus;
  note: string | null;
}

export const attendanceApi = {
  // 그날 전체 (학생마다 조회하면 N+1 — 한 번에 받아 메모리 조인)
  getByDate: async (teacherId: string, date: string): Promise<AttendanceRow[]> => {
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('teacher_id', teacherId)
      .eq('attendance_date', date);
    if (error) throw error;
    return data || [];
  },

  getOne: async (studentId: string, date: string): Promise<AttendanceRow | null> => {
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('student_id', studentId)
      .eq('attendance_date', date)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  setStatus: async (row: {
    student_id: string;
    teacher_id: string;
    attendance_date: string;
    status: AttendanceStatus;
    note?: string | null;
  }): Promise<void> => {
    const { error } = await supabase
      .from('attendance')
      .upsert(row, { onConflict: 'student_id,attendance_date' });
    if (error) throw error;
  },

  // 기간 요약 (학습보고서 보조용)
  getRange: async (studentId: string, from: string, to: string): Promise<AttendanceRow[]> => {
    const { data, error } = await supabase
      .from('attendance')
      .select('*')
      .eq('student_id', studentId)
      .gte('attendance_date', from)
      .lte('attendance_date', to)
      .order('attendance_date', { ascending: true });
    if (error) throw error;
    return data || [];
  },
};

// ===== 문자 발송 / 학습보고서 =====
// 발송은 반드시 백엔드를 거친다 — 전화번호를 클라이언트가 다루지 않고,
// 서버가 소유권(내 학생인가)을 검증한다. RLS 가 없어 이게 유일한 방어선이다.

async function _teacherFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await _nodeAuthHeaders();
  const resp = await fetch(`${TUTOR_API_BASE_URL}${path}`, { ...init, headers });
  if (!resp.ok) {
    let detail = '요청에 실패했습니다';
    try { detail = (await resp.json())?.detail || detail; } catch { /* ignore */ }
    throw new Error(detail);
  }
  return resp.json();
}

export interface MessageSendResult {
  batch_id: string;
  mock: boolean;
  sent: number;
  failed: number;
  skipped: number;
  results: { student_id: string; student_name: string; status: string; error: string | null }[];
}

export interface MessageLogRow {
  id: string;
  student_id: string | null;
  batch_id: string;
  recipient_kind: string;
  recipient_phone: string;
  message_type: string;
  body: string;
  status: string;
  error: string | null;
  sent_at: string;
}

// SMS 90byte(한글 2byte) 초과 → LMS. 백엔드 sms_sender.sms_bytes 와 같은 규칙.
export const smsBytes = (s: string) =>
  Array.from(s).reduce((n, ch) => n + (ch.charCodeAt(0) > 0x7f ? 2 : 1), 0);

export const messageApi = {
  getConfig: () =>
    _teacherFetch<{ configured: boolean; academy_name: string }>('/api/messages/config'),

  send: (body: {
    student_ids: string[];
    template: string;
    recipient_kind?: 'parent' | 'student';
    message_type?: 'notice' | 'attendance' | 'report';
    extra_vars?: Record<string, string>;
    report_id?: string;
  }) =>
    _teacherFetch<MessageSendResult>('/api/messages/send', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // 로그 조회는 읽기라 supabase 직결 (저장소 관례)
  getLogs: async (
    teacherId: string,
    filters: { from?: string; to?: string; messageType?: string; status?: string; limit?: number } = {}
  ): Promise<MessageLogRow[]> => {
    let q = supabase
      .from('message_logs')
      .select('*')
      .eq('teacher_id', teacherId)
      .order('sent_at', { ascending: false })
      .limit(filters.limit ?? 200);

    if (filters.from) q = q.gte('sent_at', new Date(`${filters.from}T00:00:00`).toISOString());
    if (filters.to) q = q.lte('sent_at', new Date(`${filters.to}T23:59:59`).toISOString());
    if (filters.messageType) q = q.eq('message_type', filters.messageType);
    if (filters.status) q = q.eq('status', filters.status);

    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  },
};

export interface MonthlyReportSummary {
  distributions_count: number;
  assigned_problems: number;
  attempted: number;
  correct: number;
  accuracy: number;
  new_wrong_problems: number;
  resolved_problems: number;
  attendance_total: number;
  attendance_present: number;
  attendance_late: number;
  attendance_absent: number;
  attendance_rate: number;
}

export interface MonthlyDistributionRow {
  distribution_id: string;
  distribution_title: string;
  distribution_date: string;
  review_stage: number | null;
  review_kind: ReviewKind | null;
  total_problems: number;
  attempted: number;
  correct: number;
  accuracy: number;
}

export interface WrongTrendRow {
  bucket_start: string;
  attempted: number;
  wrong: number;
  accuracy: number;
}

export interface MonthlyReportRecord {
  id: string;
  student_id: string;
  teacher_id: string;
  year: number;
  month: number;
  feedback: string;
  sms_body: string | null;
  snapshot: any;
  sent_at: string | null;
}

const _num = (v: any) => Number(v) || 0;

export const reportApi = {
  getSummary: async (studentId: string, year: number, month: number): Promise<MonthlyReportSummary> => {
    const { data, error } = await supabase.rpc('get_student_monthly_report', {
      p_student_id: studentId, p_year: year, p_month: month,
    });
    if (error) throw error;
    const r = (data || [])[0] || {};
    return {
      distributions_count: _num(r.distributions_count),
      assigned_problems: _num(r.assigned_problems),
      attempted: _num(r.attempted),
      correct: _num(r.correct),
      accuracy: _num(r.accuracy),
      new_wrong_problems: _num(r.new_wrong_problems),
      resolved_problems: _num(r.resolved_problems),
      attendance_total: _num(r.attendance_total),
      attendance_present: _num(r.attendance_present),
      attendance_late: _num(r.attendance_late),
      attendance_absent: _num(r.attendance_absent),
      attendance_rate: _num(r.attendance_rate),
    };
  },

  getDistributions: async (studentId: string, year: number, month: number): Promise<MonthlyDistributionRow[]> => {
    const { data, error } = await supabase.rpc('get_student_monthly_distributions', {
      p_student_id: studentId, p_year: year, p_month: month,
    });
    if (error) throw error;
    return (data || []).map((r: any) => ({
      distribution_id: r.distribution_id,
      distribution_title: r.distribution_title,
      distribution_date: r.distribution_date,
      review_stage: r.review_stage == null ? null : _num(r.review_stage),
      review_kind: (r.review_kind as ReviewKind) ?? null,
      total_problems: _num(r.total_problems),
      attempted: _num(r.attempted),
      correct: _num(r.correct),
      accuracy: _num(r.accuracy),
    }));
  },

  getWrongTrend: async (studentId: string, from: string, to: string): Promise<WrongTrendRow[]> => {
    const { data, error } = await supabase.rpc('get_student_wrong_trend', {
      p_student_id: studentId, p_from: from, p_to: to,
    });
    if (error) throw error;
    return (data || []).map((r: any) => ({
      bucket_start: r.bucket_start,
      attempted: _num(r.attempted),
      wrong: _num(r.wrong),
      accuracy: _num(r.accuracy),
    }));
  },

  get: async (studentId: string, year: number, month: number): Promise<MonthlyReportRecord | null> => {
    // 합성키 조회 — 030 의 UNIQUE(student_id, year, month) 와 짝
    const { data, error } = await supabase
      .from('monthly_reports')
      .select('*')
      .eq('student_id', studentId)
      .eq('year', year)
      .eq('month', month)
      .maybeSingle();
    if (error) throw error;
    return data;
  },

  save: async (row: {
    student_id: string; teacher_id: string; year: number; month: number;
    feedback: string; snapshot: any;
  }): Promise<MonthlyReportRecord> => {
    const { data, error } = await supabase
      .from('monthly_reports')
      .upsert(row, { onConflict: 'student_id,year,month' })
      .select()
      .single();
    if (error) throw error;
    return data;
  },
};

// ===== 통합 폴더 (027 problem_folders) =====
// 옛 chapters/subchapters 는 027 에서 id 를 보존한 채 이 테이블로 이전됐다.
// CMS 와 백엔드 승격 경로는 folder_id 만 채우므로, 신규 코드는 여기만 본다.

export interface ProblemFolderRow {
  id: string;
  textbook_id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
}

export const problemFolderApi = {
  getFoldersByTextbook: async (textbookId: string): Promise<ProblemFolderRow[]> => {
    const { data, error } = await supabase
      .from('problem_folders')
      .select('id, textbook_id, parent_id, name, sort_order')
      .eq('textbook_id', textbookId)
      .order('sort_order', { ascending: true });
    if (error) throw error;
    return data || [];
  },

  // 자기 자신 + 모든 하위 폴더 id (폴더를 고르면 그 아래 문제까지 보이게)
  descendantIds: (folders: ProblemFolderRow[], rootId: string): string[] => {
    const out = [rootId];
    for (let i = 0; i < out.length; i++) {
      for (const f of folders) if (f.parent_id === out[i]) out.push(f.id);
    }
    return out;
  },

  /**
   * 루트부터 그 폴더까지의 이름 경로. `['B단계', '나머지정리와 인수분해']`
   *
   * 배포 제목에 쓴다 — 폴더 이름만 찍으면 "쎈 나머지정리와 인수분해" 인지
   * "rpm 나머지정리와 인수분해" 인지 구별이 안 된다(사용자 지적).
   * 순환 참조가 있어도 멈추도록 방문한 id 를 기억한다.
   */
  pathNames: (folders: ProblemFolderRow[], folderId: string): string[] => {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const out: string[] = [];
    const seen = new Set<string>();
    let cur = byId.get(folderId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      out.unshift(cur.name);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return out;
  },

  // 트리를 깊이우선으로 펴서 [폴더, 깊이] 목록으로 — native select 들여쓰기용
  flatten: (
    folders: ProblemFolderRow[],
    parentId: string | null = null,
    depth = 0
  ): { folder: ProblemFolderRow; depth: number }[] => {
    const out: { folder: ProblemFolderRow; depth: number }[] = [];
    folders
      .filter((f) => f.parent_id === parentId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name))
      .forEach((f) => {
        out.push({ folder: f, depth });
        out.push(...problemFolderApi.flatten(folders, f.id, depth + 1));
      });
    return out;
  },
};
