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
  getProblems: async (teacherId, filters?: { textbookId?: string; chapterId?: string; subchapterId?: string }) => {
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
        // 먼저 학생이 이 배포에 접근할 수 있는지 확인
        const { data: accessCheck, error: accessError } = await supabase
          .from('distribution_students')
          .select('distribution_id')
          .eq('distribution_id', id)
          .eq('student_id', profile.id)
          .single();

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
  getStudentDistributions: async (studentId) => {
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

      const { data: distributions, error: distError } = await supabase
        .from('distributions')
        .select('*')
        .in('id', distributionIds)
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
      
      // 1. 선생님의 프로필 ID 찾기
      const { data: teacherProfile, error: teacherError } = await supabase
        .from('profiles')
        .select('id')
        .eq('email', teacherEmail)
        .eq('role', 'teacher')
        .single();

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
  }
};

// ===== 오답 노트 관련 API =====
export const wrongAnswerApi = {
  // 오답 추가 (중복 처리)
  addWrongAnswer: async (data) => {
    try {
      // 먼저 기존 오답이 있는지 확인
      const { data: existingWrongAnswer, error: checkError } = await supabase
        .from('wrong_answers')
        .select('id')
        .eq('student_id', data.student_id)
        .eq('problem_id', data.problem_id)
        .single();

      if (checkError && checkError.code !== 'PGRST116') {
        // PGRST116는 "결과가 없음" 에러이므로 무시
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
  }) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error('로그인이 필요합니다');

    const resp = await fetch(`${TUTOR_API_BASE_URL}/api/tutor/hint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        problem_id: params.problemId,
        student_blocked_description: params.blockedDescription,
        revealed_node_index: params.revealedNodeIndex ?? -1,
      }),
    });

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
};
